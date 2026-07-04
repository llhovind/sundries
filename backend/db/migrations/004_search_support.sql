-- ============================================================================
-- 004_search_support.sql
-- Search infrastructure:
--   * products.search_tsv — generated tsvector + GIN index, powering the
--     built-in Postgres search adapter (small installs need no extra server).
--   * search_outbox — transactional outbox for the OpenSearch adapter: catalog
--     writes enqueue rows here in the same transaction; the pg-boss worker
--     drains them into the search index. Survives OpenSearch downtime and
--     guarantees no lost updates (at-least-once, idempotent upserts).
-- ============================================================================

ALTER TABLE products ADD COLUMN search_tsv tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', COALESCE(name, '')),  'A') ||
        setweight(to_tsvector('english', COALESCE(brand, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(descr, '')), 'C')
    ) STORED;

CREATE INDEX products_search_idx ON products USING GIN (search_tsv);

CREATE TABLE search_outbox (
    id           BIGSERIAL PRIMARY KEY,
    _product_no  BIGINT NOT NULL,
    op           TEXT   NOT NULL CHECK (op IN ('upsert', 'delete')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);
CREATE INDEX search_outbox_pending_idx ON search_outbox (id) WHERE processed_at IS NULL;

-- Catalog changes enqueue outbox rows in the same transaction as the write.
-- Cheap even when OpenSearch is not in use; the worker only drains the table
-- when the opensearch adapter is active, and processed rows are pruned.

CREATE FUNCTION fn_products_search_outbox() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        INSERT INTO search_outbox (_product_no, op) VALUES (OLD.product_no, 'delete');
        RETURN OLD;
    END IF;
    INSERT INTO search_outbox (_product_no, op)
    VALUES (NEW.product_no, CASE WHEN NEW.status = 'active' THEN 'upsert' ELSE 'delete' END);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_search_outbox
    AFTER INSERT OR UPDATE OR DELETE ON products
    FOR EACH ROW EXECUTE FUNCTION fn_products_search_outbox();

-- Variant changes (price, status, sku) re-index the parent product.
CREATE FUNCTION fn_variants_search_outbox() RETURNS trigger AS $$
BEGIN
    INSERT INTO search_outbox (_product_no, op)
    VALUES (COALESCE(NEW._product_no, OLD._product_no), 'upsert');
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_variants_search_outbox
    AFTER INSERT OR UPDATE OR DELETE ON product_variants
    FOR EACH ROW EXECUTE FUNCTION fn_variants_search_outbox();
