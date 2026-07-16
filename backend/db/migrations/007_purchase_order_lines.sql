-- ============================================================================
-- 007_purchase_order_lines.sql
-- Completes the purchasing module: 001 shipped the purchaseorders header
-- only. Lines carry what was ordered and at what landed unit cost; receiving
-- against a line writes IN ledger rows (FIFO layers) and advances
-- qty_received, so partial receipts are first-class.
--
-- v1 boundaries (deliberate):
--   * qty_received <= qty_ordered — vendor over-shipments are received for
--     the ordered quantity here and the excess via a manual inventory
--     receive, so the PO document always reconciles with itself.
--   * unit_cost is the landed cost per base UOM, entered by purchasing;
--     freight on the header is informational (no automatic allocation).
-- ============================================================================

CREATE TABLE purchaseorder_lines (
    id              BIGSERIAL PRIMARY KEY,
    _po_no          BIGINT  NOT NULL REFERENCES purchaseorders ON DELETE CASCADE,
    ln_no           INTEGER NOT NULL,
    _variant_no     BIGINT  NOT NULL REFERENCES product_variants,
    qty_ordered     NUMERIC(14, 4) NOT NULL CHECK (qty_ordered > 0),
    qty_received    NUMERIC(14, 4) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
    unit_cost       NUMERIC(12, 6) NOT NULL CHECK (unit_cost >= 0),
    UNIQUE (_po_no, ln_no),
    UNIQUE (_po_no, _variant_no),
    CONSTRAINT po_lines_received_within_ordered CHECK (qty_received <= qty_ordered)
);

CREATE INDEX po_lines_variant_idx ON purchaseorder_lines (_variant_no);
