-- ============================================================================
-- 001_initial_schema.sql
-- Sundries — initial schema for a fresh install.
--
-- Design principles (see project plan):
--   * Immutable inventory & payment ledgers — enforced by triggers, not convention.
--   * inventory_balances is derived state maintained by a DB trigger so that
--     every writer (any API instance, support script, ETL) keeps it consistent.
--   * FIFO costing via inventory_cost_layers, consumed inside the DB at issue
--     time so OUT rows are stamped with their true cost at write time.
--   * Reservations are guarded by CHECK constraints + conditional UPDATEs;
--     the database is the single point of integrity for multi-instance APIs.
--   * inventory_transactions is range-partitioned from day one; small installs
--     simply run everything in the DEFAULT partition (see fn_ensure_inventory_partitions).
--
-- Requires PostgreSQL 13+ (row triggers on partitioned tables). Tested target: 16 (CI).
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- RBAC
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE roles (
    role_no     BIGSERIAL PRIMARY KEY,
    code        TEXT        NOT NULL UNIQUE,
    name        TEXT        NOT NULL,
    descr       TEXT,
    is_system   BOOLEAN     NOT NULL DEFAULT FALSE,
    _create_ts  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE permissions (
    perm_no     BIGSERIAL PRIMARY KEY,
    code        TEXT        NOT NULL UNIQUE,
    descr       TEXT,
    _create_ts  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE role_permissions (
    role_no     BIGINT NOT NULL REFERENCES roles ON DELETE CASCADE,
    perm_no     BIGINT NOT NULL REFERENCES permissions ON DELETE CASCADE,
    PRIMARY KEY (role_no, perm_no)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Users & auth (passwordless — OTP by email; guests get implicit accounts)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE users (
    id              BIGSERIAL PRIMARY KEY,
    username        TEXT        NOT NULL,
    email           TEXT        NOT NULL,
    -- Legacy single-role column kept so the current auth middleware keeps
    -- working during the conversion. user_roles is the source of truth for
    -- permissions; this column is removed once requirePermission() lands.
    role            TEXT        NOT NULL DEFAULT 'customer' REFERENCES roles (code),
    status          TEXT        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'inactive')),
    is_guest        BOOLEAN     NOT NULL DEFAULT FALSE,
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX users_email_uq    ON users (LOWER(email));
CREATE UNIQUE INDEX users_username_uq ON users (LOWER(username));

CREATE TABLE user_roles (
    user_id     BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
    role_no     BIGINT NOT NULL REFERENCES roles ON DELETE CASCADE,
    granted_by  BIGINT REFERENCES users,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, role_no)
);

CREATE TABLE otp_codes (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users ON DELETE CASCADE,
    otp_hash    TEXT        NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    _create_ts  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX otp_codes_user_idx ON otp_codes (user_id, expires_at);

CREATE TABLE refresh_tokens (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users ON DELETE CASCADE,
    token_hash  TEXT        NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    _create_ts  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE invitation_codes (
    id          BIGSERIAL PRIMARY KEY,
    code        TEXT        NOT NULL UNIQUE,
    label       TEXT,
    expires_at  TIMESTAMPTZ,
    max_uses    INTEGER,
    use_count   INTEGER     NOT NULL DEFAULT 0,
    _create_ts  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────────────
-- Parties
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE customers (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT UNIQUE REFERENCES users,
    name            TEXT NOT NULL,
    email           TEXT,
    address         TEXT,
    city            TEXT,
    state           TEXT,
    country         TEXT,
    zip             TEXT,
    phone           TEXT,
    notes           TEXT,
    is_guest        BOOLEAN     NOT NULL DEFAULT FALSE,
    status          TEXT        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'inactive')),
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _create_user_id BIGINT,
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT
);
CREATE INDEX customers_email_idx ON customers (LOWER(email));

CREATE TABLE vendors (
    id              BIGSERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    address         TEXT,
    city            TEXT,
    state           TEXT,
    country         TEXT,
    zip             TEXT,
    phone           TEXT,
    fax             TEXT,
    website         TEXT,
    notes           TEXT,
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _create_user_id BIGINT,
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT
);

-- ────────────────────────────────────────────────────────────────────────────
-- Units of measure
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE units_of_measure (
    uom_code        TEXT PRIMARY KEY,          -- 'each', 'in', 'ft', 'yd', 'm'
    name            TEXT NOT NULL,
    is_fractional   BOOLEAN NOT NULL DEFAULT FALSE
);

-- qty_in_to = qty_in_from * ratio
CREATE TABLE uom_conversions (
    from_uom    TEXT NOT NULL REFERENCES units_of_measure,
    to_uom      TEXT NOT NULL REFERENCES units_of_measure,
    ratio       NUMERIC(18, 8) NOT NULL CHECK (ratio > 0),
    PRIMARY KEY (from_uom, to_uom)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Catalog: products → variants (the sellable/stockable SKU)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE products (
    product_no      BIGSERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    descr           TEXT,
    brand           TEXT,
    status          TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'active', 'inactive')),
    sell_method     TEXT NOT NULL DEFAULT 'unit'
                         CHECK (sell_method IN ('unit', 'measure')),
    base_uom        TEXT NOT NULL DEFAULT 'each' REFERENCES units_of_measure,
    -- Minimum cut for measured goods (in base_uom). NULL for unit goods.
    min_cut_qty     NUMERIC(14, 4) CHECK (min_cut_qty IS NULL OR min_cut_qty > 0),
    weight_lbs      NUMERIC(10, 3) CHECK (weight_lbs IS NULL OR weight_lbs >= 0),
    attributes      JSONB NOT NULL DEFAULT '{}',   -- display-only metadata (material, care, …)
    primary_image   TEXT,
    notes           TEXT,
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _create_user_id BIGINT,
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT,
    CONSTRAINT products_min_cut_only_for_measure
        CHECK (min_cut_qty IS NULL OR sell_method = 'measure')
);
CREATE INDEX products_name_idx   ON products (LOWER(name));
CREATE INDEX products_status_idx ON products (status);

CREATE TABLE product_options (
    option_no   BIGSERIAL PRIMARY KEY,
    _product_no BIGINT NOT NULL REFERENCES products ON DELETE CASCADE,
    name        TEXT   NOT NULL,                  -- 'Color', 'Quality', 'Size'
    position    INTEGER NOT NULL DEFAULT 0,
    UNIQUE (_product_no, name)
);

CREATE TABLE product_option_values (
    value_no    BIGSERIAL PRIMARY KEY,
    _option_no  BIGINT NOT NULL REFERENCES product_options ON DELETE CASCADE,
    value       TEXT   NOT NULL,                  -- 'Red', 'Grade A', '2ft'
    position    INTEGER NOT NULL DEFAULT 0,
    UNIQUE (_option_no, value)
);

CREATE TABLE product_variants (
    variant_no      BIGSERIAL PRIMARY KEY,
    _product_no     BIGINT NOT NULL REFERENCES products ON DELETE CASCADE,
    sku             TEXT   NOT NULL UNIQUE,
    price           NUMERIC(12, 4) NOT NULL CHECK (price >= 0),  -- per base_uom
    status          TEXT   NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'inactive')),
    weight_lbs      NUMERIC(10, 3) CHECK (weight_lbs IS NULL OR weight_lbs >= 0),
    primary_image   TEXT,
    position        INTEGER NOT NULL DEFAULT 0,
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _create_user_id BIGINT,
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT
);
CREATE INDEX product_variants_product_idx ON product_variants (_product_no);

CREATE TABLE product_variant_values (
    variant_no  BIGINT NOT NULL REFERENCES product_variants ON DELETE CASCADE,
    value_no    BIGINT NOT NULL REFERENCES product_option_values ON DELETE CASCADE,
    PRIMARY KEY (variant_no, value_no)
);

CREATE TABLE categories (
    id              BIGSERIAL PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    parent_id       BIGINT REFERENCES categories,
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _create_user_id BIGINT,
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT
);

CREATE TABLE product_categories (
    _product_no  BIGINT NOT NULL REFERENCES products   ON DELETE CASCADE,
    _category_id BIGINT NOT NULL REFERENCES categories ON DELETE CASCADE,
    PRIMARY KEY (_product_no, _category_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Warehouses
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE warehouses (
    warehouse_no    BIGSERIAL PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    wh_type         TEXT NOT NULL DEFAULT 'standard'
                         CHECK (wh_type IN ('standard', 'transport')),
    address         TEXT,
    city            TEXT,
    state           TEXT,
    country         TEXT,
    zip             TEXT,
    -- Reservation allocation walks standard warehouses in priority order (lowest first).
    priority        INTEGER NOT NULL DEFAULT 100,
    default_carrier TEXT,
    status          TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'inactive')),
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _create_user_id BIGINT,
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT
);

-- ────────────────────────────────────────────────────────────────────────────
-- Inventory ledger (immutable, partitioned) + derived balances + FIFO layers
-- ────────────────────────────────────────────────────────────────────────────

-- Explicit sequence: identity columns on partitioned tables need PG17+.
CREATE SEQUENCE inventory_transactions_trn_no_seq AS BIGINT;

CREATE TABLE inventory_transactions (
    trn_no          BIGINT NOT NULL DEFAULT nextval('inventory_transactions_trn_no_seq'),
    _trn_dt         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _trn_type       TEXT   NOT NULL
                           CHECK (_trn_type IN ('IN', 'OUT', 'RET', 'XFER_IN', 'XFER_OUT', 'ADJ')),
    _variant_no     BIGINT NOT NULL REFERENCES product_variants,
    _warehouse_no   BIGINT NOT NULL REFERENCES warehouses,
    -- Signed quantity in the product's base UOM: positive receives, negative issues.
    qty             NUMERIC(14, 4) NOT NULL,
    -- Provenance of the original entry (e.g. customer bought 2 yd = qty -6 ft).
    entered_qty     NUMERIC(14, 4),
    entered_uom     TEXT REFERENCES units_of_measure,
    -- unit_cost: set by caller on receipts; stamped by FIFO trigger on issues.
    unit_cost       NUMERIC(12, 6),
    -- unit_price: selling price per base UOM (sales OUT rows only).
    unit_price      NUMERIC(12, 4),
    reason_code     TEXT,                          -- 'remnant', 'damage', 'count', …
    _lnk_table      TEXT   NOT NULL DEFAULT 'manual',
    _lnk_id         BIGINT NOT NULL DEFAULT 0,
    _ln_no          INTEGER NOT NULL DEFAULT 1,
    notes           TEXT,
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _create_user_id BIGINT,
    PRIMARY KEY (trn_no, _trn_dt),
    CONSTRAINT inv_trn_qty_sign CHECK (
        (_trn_type IN ('IN', 'RET', 'XFER_IN') AND qty > 0) OR
        (_trn_type IN ('OUT', 'XFER_OUT')      AND qty < 0) OR
        (_trn_type = 'ADJ'                     AND qty <> 0)
    )
) PARTITION BY RANGE (_trn_dt);

-- Small installs run entirely in the default partition; larger installs let
-- fn_ensure_inventory_partitions() carve monthly partitions ahead of time.
CREATE TABLE inventory_transactions_default PARTITION OF inventory_transactions DEFAULT;

CREATE INDEX inv_trn_variant_idx ON inventory_transactions (_variant_no, _warehouse_no, _trn_dt);
CREATE INDEX inv_trn_link_idx    ON inventory_transactions (_lnk_table, _lnk_id);
CREATE INDEX inv_trn_type_dt_idx ON inventory_transactions (_trn_type, _trn_dt);

CREATE TABLE inventory_balances (
    _variant_no     BIGINT NOT NULL REFERENCES product_variants,
    _warehouse_no   BIGINT NOT NULL REFERENCES warehouses,
    qty_on_hand     NUMERIC(14, 4) NOT NULL DEFAULT 0,
    qty_reserved    NUMERIC(14, 4) NOT NULL DEFAULT 0,
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (_variant_no, _warehouse_no),
    -- The oversell guard. Enforced by the engine for every writer.
    CONSTRAINT balances_reserved_nonneg CHECK (qty_reserved >= 0),
    CONSTRAINT balances_on_hand_covers_reserved CHECK (qty_on_hand >= qty_reserved)
);

CREATE TABLE inventory_reservations (
    reservation_no  BIGSERIAL PRIMARY KEY,
    _ord_no         BIGINT NOT NULL,               -- FK added after orders exists
    _variant_no     BIGINT NOT NULL REFERENCES product_variants,
    _warehouse_no   BIGINT NOT NULL REFERENCES warehouses,
    qty             NUMERIC(14, 4) NOT NULL CHECK (qty > 0),
    status          TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'consumed', 'released', 'expired')),
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ,
    released_at     TIMESTAMPTZ,
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _create_user_id BIGINT
);
CREATE INDEX inv_res_sweeper_idx ON inventory_reservations (expires_at) WHERE status = 'active';
CREATE INDEX inv_res_order_idx   ON inventory_reservations (_ord_no);

CREATE TABLE inventory_cost_layers (
    layer_no        BIGSERIAL PRIMARY KEY,
    _variant_no     BIGINT NOT NULL REFERENCES product_variants,
    _warehouse_no   BIGINT NOT NULL REFERENCES warehouses,
    source_trn_no   BIGINT NOT NULL,
    received_dt     TIMESTAMPTZ NOT NULL,
    qty_received    NUMERIC(14, 4) NOT NULL CHECK (qty_received > 0),
    qty_remaining   NUMERIC(14, 4) NOT NULL,
    unit_cost       NUMERIC(12, 6) NOT NULL CHECK (unit_cost >= 0),
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT layers_remaining_bounds CHECK (qty_remaining >= 0 AND qty_remaining <= qty_received)
);
CREATE INDEX cost_layers_fifo_idx
    ON inventory_cost_layers (_variant_no, _warehouse_no, received_dt, layer_no)
    WHERE qty_remaining > 0;

-- ────────────────────────────────────────────────────────────────────────────
-- Stock transfers (warehouse → transport warehouse → warehouse)
-- Carrier/manifest/billing live per-transfer so concurrent shipments coexist.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE stock_transfers (
    transfer_no             BIGSERIAL PRIMARY KEY,
    _from_warehouse_no      BIGINT NOT NULL REFERENCES warehouses,
    _to_warehouse_no        BIGINT NOT NULL REFERENCES warehouses,
    _transport_warehouse_no BIGINT NOT NULL REFERENCES warehouses,
    status                  TEXT NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'dispatched', 'received', 'cancelled')),
    carrier                 TEXT,
    manifest_id             TEXT,
    billing_no              TEXT,
    tracking_no             TEXT,
    notes                   TEXT,
    dispatched_at           TIMESTAMPTZ,
    received_at             TIMESTAMPTZ,
    _create_ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _create_user_id         BIGINT,
    _modify_ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id         BIGINT,
    CONSTRAINT transfers_distinct_endpoints CHECK (_from_warehouse_no <> _to_warehouse_no)
);

CREATE TABLE stock_transfer_lines (
    id           BIGSERIAL PRIMARY KEY,
    _transfer_no BIGINT NOT NULL REFERENCES stock_transfers ON DELETE CASCADE,
    ln_no        INTEGER NOT NULL,
    _variant_no  BIGINT NOT NULL REFERENCES product_variants,
    qty          NUMERIC(14, 4) NOT NULL CHECK (qty > 0),
    UNIQUE (_transfer_no, _variant_no)
);

CREATE TABLE stock_notifications (
    id           BIGSERIAL PRIMARY KEY,
    _variant_no  BIGINT NOT NULL REFERENCES product_variants,
    email        TEXT NOT NULL,
    _customer_id BIGINT REFERENCES customers,
    status       TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'notified', 'cancelled')),
    _create_ts   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notified_at  TIMESTAMPTZ
);
CREATE INDEX stock_notif_variant_idx ON stock_notifications (_variant_no) WHERE status = 'pending';

-- ────────────────────────────────────────────────────────────────────────────
-- Purchasing
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE purchaseorders (
    po_no           BIGSERIAL PRIMARY KEY,
    _vendor_id      BIGINT NOT NULL REFERENCES vendors,
    _warehouse_no   BIGINT NOT NULL REFERENCES warehouses,   -- receiving warehouse
    vendor_ordno    TEXT,
    vendor_invno    TEXT,
    po_dt           TIMESTAMPTZ NOT NULL,
    adj_reason      TEXT,
    adj             NUMERIC(12, 2),
    subtotal        NUMERIC(12, 2),
    freight         NUMERIC(12, 2),
    po_status       TEXT NOT NULL DEFAULT 'open'
                         CHECK (po_status IN ('open', 'received', 'closed', 'cancelled')),
    notes           TEXT,
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _create_user_id BIGINT,
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT
);

-- ────────────────────────────────────────────────────────────────────────────
-- Carts (supports anonymous/guest sessions) & orders
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE carts (
    cart_no         BIGSERIAL PRIMARY KEY,
    _user_id        BIGINT REFERENCES users,
    session_token   UUID UNIQUE DEFAULT gen_random_uuid(),
    status          TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'converted', 'abandoned')),
    notes           TEXT,
    _ord_no         BIGINT,                        -- FK added after orders exists
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT carts_owner_present CHECK (_user_id IS NOT NULL OR session_token IS NOT NULL)
);
-- One open cart per authenticated user (anonymous carts are keyed by token).
CREATE UNIQUE INDEX carts_one_open_per_user
    ON carts (_user_id) WHERE status = 'open' AND _user_id IS NOT NULL;

CREATE TABLE cart_items (
    id          BIGSERIAL PRIMARY KEY,
    _cart_no    BIGINT NOT NULL REFERENCES carts ON DELETE CASCADE,
    _variant_no BIGINT NOT NULL REFERENCES product_variants,
    qty         NUMERIC(14, 4) NOT NULL CHECK (qty > 0),   -- in base UOM
    entered_qty NUMERIC(14, 4),
    entered_uom TEXT REFERENCES units_of_measure,
    unit_price  NUMERIC(12, 4),                            -- snapshot at add-time
    _create_ts  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_ts  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (_cart_no, _variant_no)
);

CREATE TABLE orders (
    ord_no          BIGSERIAL PRIMARY KEY,
    _customer_id    BIGINT NOT NULL REFERENCES customers,
    email           TEXT   NOT NULL,               -- contact snapshot (guest lookup key)
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    subtotal        NUMERIC(12, 2) NOT NULL DEFAULT 0,
    discount_amt    NUMERIC(12, 2) NOT NULL DEFAULT 0,
    tax             NUMERIC(12, 2) NOT NULL DEFAULT 0,
    shipping        NUMERIC(12, 2) NOT NULL DEFAULT 0,
    total           NUMERIC(12, 2) NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending_payment'
                         CHECK (status IN ('pending_payment', 'paid', 'processing',
                                           'partially_shipped', 'shipped', 'completed',
                                           'cancelled', 'payment_failed')),
    placed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _cart_no        BIGINT REFERENCES carts,
    -- Shipping address snapshot — orders must not follow later customer edits.
    ship_name       TEXT,
    ship_address    TEXT,
    ship_city       TEXT,
    ship_state      TEXT,
    ship_zip        TEXT,
    ship_country    TEXT,
    ship_phone      TEXT,
    fraud_flag      BOOLEAN NOT NULL DEFAULT FALSE,
    fraud_notes     TEXT,
    notes           TEXT,
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _create_user_id BIGINT,
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT
);
CREATE INDEX orders_customer_idx  ON orders (_customer_id, placed_at DESC);
CREATE INDEX orders_status_idx    ON orders (status, placed_at DESC);
CREATE INDEX orders_email_idx     ON orders (LOWER(email));

ALTER TABLE inventory_reservations
    ADD CONSTRAINT inv_res_order_fk FOREIGN KEY (_ord_no) REFERENCES orders;
ALTER TABLE carts
    ADD CONSTRAINT carts_order_fk FOREIGN KEY (_ord_no) REFERENCES orders;

CREATE TABLE order_lines (
    id                  BIGSERIAL PRIMARY KEY,
    _ord_no             BIGINT NOT NULL REFERENCES orders ON DELETE CASCADE,
    ln_no               INTEGER NOT NULL,
    _variant_no         BIGINT NOT NULL REFERENCES product_variants,
    sku                 TEXT,                      -- snapshot
    descr               TEXT,                      -- snapshot
    qty                 NUMERIC(14, 4) NOT NULL CHECK (qty > 0),   -- base UOM
    entered_qty         NUMERIC(14, 4),
    entered_uom         TEXT REFERENCES units_of_measure,
    unit_price          NUMERIC(12, 4) NOT NULL,
    line_total          NUMERIC(12, 2) NOT NULL,
    fulfillment_status  TEXT NOT NULL DEFAULT 'pending'
                             CHECK (fulfillment_status IN ('pending', 'reserved', 'backordered',
                                                           'shipped', 'cancelled')),
    _warehouse_no       BIGINT REFERENCES warehouses,   -- allocation, set at reservation
    UNIQUE (_ord_no, ln_no)
);
CREATE INDEX order_lines_variant_idx ON order_lines (_variant_no);
CREATE INDEX order_lines_backorder_idx ON order_lines (_variant_no)
    WHERE fulfillment_status = 'backordered';

CREATE TABLE order_status_history (
    id          BIGSERIAL PRIMARY KEY,
    _ord_no     BIGINT NOT NULL REFERENCES orders ON DELETE CASCADE,
    from_status TEXT,
    to_status   TEXT NOT NULL,
    changed_by  BIGINT,
    note        TEXT,
    _create_ts  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX order_status_history_ord_idx ON order_status_history (_ord_no);

-- ────────────────────────────────────────────────────────────────────────────
-- Payments (provider-agnostic; raw provider payloads land in payment_events)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE payments (
    payment_no      BIGSERIAL PRIMARY KEY,
    _ord_no         BIGINT NOT NULL REFERENCES orders,
    provider        TEXT NOT NULL,                 -- 'stripe', 'paypal'
    provider_ref    TEXT,                          -- charge/capture id
    intent_ref      TEXT,                          -- payment intent / paypal order id
    amount          NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    currency        CHAR(3) NOT NULL,
    status          TEXT NOT NULL DEFAULT 'created'
                         CHECK (status IN ('created', 'authorized', 'captured', 'failed',
                                           'cancelled', 'refunded', 'partially_refunded')),
    idempotency_key TEXT UNIQUE,
    error_code      TEXT,
    error_msg       TEXT,
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX payments_order_idx ON payments (_ord_no);
CREATE INDEX payments_intent_idx ON payments (provider, intent_ref);

CREATE TABLE payment_events (
    event_no          BIGSERIAL PRIMARY KEY,
    provider          TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    _payment_no       BIGINT REFERENCES payments,
    event_type        TEXT NOT NULL,
    payload           JSONB NOT NULL,
    received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at      TIMESTAMPTZ,
    UNIQUE (provider, provider_event_id)          -- webhook replay dedupe
);
CREATE INDEX payment_events_unprocessed_idx ON payment_events (received_at) WHERE processed_at IS NULL;

CREATE TABLE refunds (
    refund_no       BIGSERIAL PRIMARY KEY,
    _payment_no     BIGINT NOT NULL REFERENCES payments,
    _ord_no         BIGINT NOT NULL REFERENCES orders,
    _rma_no         BIGINT,                        -- FK added after rmas exists
    amount          NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    reason          TEXT NOT NULL,
    provider_ref    TEXT,
    status          TEXT NOT NULL DEFAULT 'created'
                         CHECK (status IN ('created', 'completed', 'failed')),
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _create_user_id BIGINT,
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT
);

-- ────────────────────────────────────────────────────────────────────────────
-- RMA / returns (stub workflow)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE rmas (
    rma_no          BIGSERIAL PRIMARY KEY,
    _ord_no         BIGINT NOT NULL REFERENCES orders,
    status          TEXT NOT NULL DEFAULT 'requested'
                         CHECK (status IN ('requested', 'approved', 'rejected',
                                           'received', 'refunded', 'closed')),
    reason          TEXT,
    notes           TEXT,
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _create_user_id BIGINT,
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT
);

CREATE TABLE rma_lines (
    id             BIGSERIAL PRIMARY KEY,
    _rma_no        BIGINT NOT NULL REFERENCES rmas ON DELETE CASCADE,
    _order_line_id BIGINT NOT NULL REFERENCES order_lines,
    qty            NUMERIC(14, 4) NOT NULL CHECK (qty > 0),
    condition      TEXT,
    restock        BOOLEAN NOT NULL DEFAULT FALSE
);

ALTER TABLE refunds
    ADD CONSTRAINT refunds_rma_fk FOREIGN KEY (_rma_no) REFERENCES rmas;

-- ────────────────────────────────────────────────────────────────────────────
-- Promotions (stub engine)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE promotions (
    promo_no         BIGSERIAL PRIMARY KEY,
    code             TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    promo_type       TEXT NOT NULL
                          CHECK (promo_type IN ('percent', 'fixed_amount', 'free_shipping')),
    value            NUMERIC(12, 4) NOT NULL DEFAULT 0 CHECK (value >= 0),
    starts_at        TIMESTAMPTZ,
    ends_at          TIMESTAMPTZ,
    max_redemptions  INTEGER,
    redemption_count INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'active', 'inactive')),
    _create_ts       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _create_user_id  BIGINT,
    _modify_ts       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id  BIGINT
);

CREATE TABLE promotion_redemptions (
    id           BIGSERIAL PRIMARY KEY,
    _promo_no    BIGINT NOT NULL REFERENCES promotions,
    _ord_no      BIGINT NOT NULL REFERENCES orders,
    _customer_id BIGINT REFERENCES customers,
    amount       NUMERIC(12, 2) NOT NULL,
    _create_ts   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────────────
-- Shipping & tax configuration (admin-editable, consumed by the rule adapters)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE shipping_rules (
    rule_no         BIGSERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    min_subtotal    NUMERIC(12, 2) NOT NULL DEFAULT 0,
    max_subtotal    NUMERIC(12, 2),                -- NULL = no upper bound
    base_amount     NUMERIC(12, 2) NOT NULL CHECK (base_amount >= 0),
    priority        INTEGER NOT NULL DEFAULT 100,
    status          TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'inactive')),
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT
);

CREATE TABLE shipping_weight_bands (
    band_no         BIGSERIAL PRIMARY KEY,
    min_weight_lbs  NUMERIC(10, 3) NOT NULL,
    max_weight_lbs  NUMERIC(10, 3),                -- NULL = no upper bound
    surcharge       NUMERIC(12, 2) NOT NULL CHECK (surcharge >= 0),
    status          TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'inactive')),
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT
);

CREATE TABLE tax_rates (
    rate_no         BIGSERIAL PRIMARY KEY,
    country         TEXT NOT NULL,
    state           TEXT,
    postal_prefix   TEXT,
    rate            NUMERIC(8, 5) NOT NULL CHECK (rate >= 0),
    name            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'inactive')),
    _create_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT
);

-- ────────────────────────────────────────────────────────────────────────────
-- Operations: audit log, compliance stubs, app settings
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE audit_log (
    audit_no        BIGSERIAL PRIMARY KEY,
    ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_user_id   BIGINT,
    action          TEXT NOT NULL,                 -- 'INSERT' | 'UPDATE' | 'DELETE' | app action
    entity          TEXT NOT NULL,
    entity_id       TEXT,
    old_data        JSONB,
    new_data        JSONB,
    ip              TEXT,
    correlation_id  TEXT
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);
CREATE INDEX audit_log_ts_idx     ON audit_log (ts);

CREATE TABLE compliance_requests (
    id           BIGSERIAL PRIMARY KEY,
    req_type     TEXT NOT NULL CHECK (req_type IN ('gdpr_export', 'gdpr_delete')),
    _customer_id BIGINT REFERENCES customers,
    email        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    notes        TEXT
);

CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    descr      TEXT,
    _modify_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT
);

-- ============================================================================
-- Functions & triggers
-- ============================================================================

-- ── Immutability guards ──────────────────────────────────────────────────────

CREATE FUNCTION fn_block_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable (append-only ledger); write a reversing entry instead', TG_TABLE_NAME
        USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inv_trn_immutable
    BEFORE UPDATE OR DELETE ON inventory_transactions
    FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

CREATE TRIGGER trg_audit_log_immutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- payment_events: immutable except marking processed / linking the payment.
CREATE FUNCTION fn_payment_events_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'payment_events rows are immutable';
    END IF;
    IF (to_jsonb(OLD) - 'processed_at' - '_payment_no')
       IS DISTINCT FROM (to_jsonb(NEW) - 'processed_at' - '_payment_no') THEN
        RAISE EXCEPTION 'payment_events rows are immutable except processed_at/_payment_no';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_events_guard
    BEFORE UPDATE OR DELETE ON payment_events
    FOR EACH ROW EXECUTE FUNCTION fn_payment_events_guard();

-- ── Balance maintenance (derived state — the ledger is the source of truth) ─

-- UPDATE-first, not INSERT ON CONFLICT: with ON CONFLICT DO UPDATE, CHECK
-- constraints are evaluated against the candidate INSERT row (e.g. a negative
-- qty_on_hand for an issue) before conflict resolution, so issues against an
-- existing balance would bounce off balances_on_hand_covers_reserved.
CREATE FUNCTION fn_inv_trn_apply_balance() RETURNS trigger AS $$
BEGIN
    UPDATE inventory_balances
        SET qty_on_hand = qty_on_hand + NEW.qty,
            _modify_ts  = NOW()
        WHERE _variant_no = NEW._variant_no AND _warehouse_no = NEW._warehouse_no;
    IF NOT FOUND THEN
        -- First movement for this variant/warehouse. ON CONFLICT covers the
        -- race where two first movements arrive concurrently; both are
        -- receipts in practice (issues without a balance fail layer checks).
        INSERT INTO inventory_balances (_variant_no, _warehouse_no, qty_on_hand, qty_reserved, _modify_ts)
        VALUES (NEW._variant_no, NEW._warehouse_no, NEW.qty, 0, NOW())
        ON CONFLICT (_variant_no, _warehouse_no) DO UPDATE
            SET qty_on_hand = inventory_balances.qty_on_hand + NEW.qty,
                _modify_ts  = NOW();
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ── FIFO costing ─────────────────────────────────────────────────────────────
-- Issues (negative qty) consume layers oldest-first and stamp the true blended
-- FIFO cost onto the ledger row itself, so COGS is a plain SUM over OUT rows.
-- Receipts (positive qty) must carry a caller-supplied unit_cost; a layer is
-- created for them in the AFTER trigger below.

CREATE FUNCTION fn_inv_trn_before_insert() RETURNS trigger AS $$
DECLARE
    remaining  NUMERIC := 0;
    total_cost NUMERIC := 0;
    take       NUMERIC;
    lyr        RECORD;
BEGIN
    IF NEW.qty > 0 THEN
        IF NEW.unit_cost IS NULL THEN
            RAISE EXCEPTION 'unit_cost is required for receiving transactions (type %, variant %)',
                NEW._trn_type, NEW._variant_no;
        END IF;
        RETURN NEW;
    END IF;

    -- Issue: consume FIFO layers. FOR UPDATE serializes concurrent issuers of
    -- the same variant/warehouse, which is required for correct layer math.
    remaining := -NEW.qty;
    FOR lyr IN
        SELECT layer_no, qty_remaining, unit_cost
        FROM inventory_cost_layers
        WHERE _variant_no = NEW._variant_no
          AND _warehouse_no = NEW._warehouse_no
          AND qty_remaining > 0
        ORDER BY received_dt, layer_no
        FOR UPDATE
    LOOP
        take := LEAST(lyr.qty_remaining, remaining);
        UPDATE inventory_cost_layers
            SET qty_remaining = qty_remaining - take
            WHERE layer_no = lyr.layer_no;
        total_cost := total_cost + take * lyr.unit_cost;
        remaining  := remaining - take;
        EXIT WHEN remaining <= 0;
    END LOOP;

    IF remaining > 0.00005 THEN
        RAISE EXCEPTION 'Insufficient FIFO cost layers for variant % at warehouse % (short by %)',
            NEW._variant_no, NEW._warehouse_no, remaining;
    END IF;

    NEW.unit_cost := ROUND(total_cost / (-NEW.qty), 6);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION fn_inv_trn_after_insert_layer() RETURNS trigger AS $$
BEGIN
    IF NEW.qty > 0 THEN
        INSERT INTO inventory_cost_layers
            (_variant_no, _warehouse_no, source_trn_no, received_dt,
             qty_received, qty_remaining, unit_cost)
        VALUES
            (NEW._variant_no, NEW._warehouse_no, NEW.trn_no, NEW._trn_dt,
             NEW.qty, NEW.qty, NEW.unit_cost);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inv_trn_10_cost
    BEFORE INSERT ON inventory_transactions
    FOR EACH ROW EXECUTE FUNCTION fn_inv_trn_before_insert();

CREATE TRIGGER trg_inv_trn_20_balance
    AFTER INSERT ON inventory_transactions
    FOR EACH ROW EXECUTE FUNCTION fn_inv_trn_apply_balance();

CREATE TRIGGER trg_inv_trn_30_layer
    AFTER INSERT ON inventory_transactions
    FOR EACH ROW EXECUTE FUNCTION fn_inv_trn_after_insert_layer();

-- ── Reservations ─────────────────────────────────────────────────────────────
-- The conditional UPDATE below is the entire oversell defense: it only
-- succeeds when free stock (on_hand - reserved) covers the request, and the
-- row lock serializes concurrent checkouts of the same variant.

-- Walks active standard warehouses in priority order; reserves from the first
-- that can satisfy the full quantity (no split shipments — by design for now).
-- Returns the chosen warehouse_no, or NULL when nothing can satisfy the line.
CREATE FUNCTION fn_allocate_and_reserve(p_variant_no BIGINT, p_qty NUMERIC)
RETURNS BIGINT AS $$
DECLARE
    wh BIGINT;
BEGIN
    IF p_qty <= 0 THEN
        RAISE EXCEPTION 'Reservation qty must be positive (got %)', p_qty;
    END IF;
    FOR wh IN
        SELECT w.warehouse_no
        FROM warehouses w
        WHERE w.wh_type = 'standard' AND w.status = 'active'
        ORDER BY w.priority, w.warehouse_no
    LOOP
        UPDATE inventory_balances
            SET qty_reserved = qty_reserved + p_qty,
                _modify_ts   = NOW()
            WHERE _variant_no   = p_variant_no
              AND _warehouse_no = wh
              AND qty_on_hand - qty_reserved >= p_qty;
        IF FOUND THEN
            RETURN wh;
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Releases (or expires) an active reservation and returns the stock to the
-- available pool. Idempotent: a second call on the same reservation is a no-op.
CREATE FUNCTION fn_release_reservation(p_reservation_no BIGINT, p_status TEXT)
RETURNS BOOLEAN AS $$
DECLARE
    res RECORD;
BEGIN
    IF p_status NOT IN ('released', 'expired') THEN
        RAISE EXCEPTION 'Invalid release status %', p_status;
    END IF;
    UPDATE inventory_reservations
        SET status = p_status, released_at = NOW()
        WHERE reservation_no = p_reservation_no AND status = 'active'
        RETURNING _variant_no, _warehouse_no, qty INTO res;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    UPDATE inventory_balances
        SET qty_reserved = qty_reserved - res.qty, _modify_ts = NOW()
        WHERE _variant_no = res._variant_no AND _warehouse_no = res._warehouse_no;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Marks a reservation consumed and frees the reserved quantity. The caller
-- must, in the SAME transaction, insert the matching OUT ledger row — and must
-- call this FIRST so the on_hand >= reserved CHECK holds mid-transaction.
CREATE FUNCTION fn_consume_reservation(p_reservation_no BIGINT)
RETURNS BOOLEAN AS $$
DECLARE
    res RECORD;
BEGIN
    UPDATE inventory_reservations
        SET status = 'consumed', consumed_at = NOW()
        WHERE reservation_no = p_reservation_no AND status = 'active'
        RETURNING _variant_no, _warehouse_no, qty INTO res;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    UPDATE inventory_balances
        SET qty_reserved = qty_reserved - res.qty, _modify_ts = NOW()
        WHERE _variant_no = res._variant_no AND _warehouse_no = res._warehouse_no;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Sweeper: releases every active reservation past its TTL. SKIP LOCKED keeps
-- multiple sweeper instances (or a sweeper racing a webhook) from colliding.
CREATE FUNCTION fn_expire_reservations() RETURNS INTEGER AS $$
DECLARE
    r     RECORD;
    count INTEGER := 0;
BEGIN
    FOR r IN
        SELECT reservation_no
        FROM inventory_reservations
        WHERE status = 'active' AND expires_at < NOW()
        FOR UPDATE SKIP LOCKED
    LOOP
        IF fn_release_reservation(r.reservation_no, 'expired') THEN
            count := count + 1;
        END IF;
    END LOOP;
    RETURN count;
END;
$$ LANGUAGE plpgsql;

-- ── Partition maintenance ────────────────────────────────────────────────────
-- Creates monthly partitions from the current month through p_months_ahead.
-- Small installs never call this and live in the DEFAULT partition. Call it
-- from a scheduled job when app_settings 'inventory.partition_months' >= 0.

CREATE FUNCTION fn_ensure_inventory_partitions(p_months_ahead INTEGER DEFAULT 3)
RETURNS INTEGER AS $$
DECLARE
    m       INTEGER;
    d_from  DATE;
    d_to    DATE;
    p_name  TEXT;
    created INTEGER := 0;
BEGIN
    FOR m IN 0..p_months_ahead LOOP
        d_from := date_trunc('month', NOW())::DATE + (m || ' months')::INTERVAL;
        d_to   := d_from + INTERVAL '1 month';
        p_name := 'inventory_transactions_' || to_char(d_from, 'YYYYMM');
        IF to_regclass(p_name) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF inventory_transactions FOR VALUES FROM (%L) TO (%L)',
                p_name, d_from, d_to
            );
            created := created + 1;
        END IF;
    END LOOP;
    RETURN created;
END;
$$ LANGUAGE plpgsql;

-- ── Order status history (audit) ─────────────────────────────────────────────

CREATE FUNCTION fn_orders_status_history() RETURNS trigger AS $$
BEGIN
    INSERT INTO order_status_history (_ord_no, from_status, to_status, changed_by)
    VALUES (NEW.ord_no, OLD.status, NEW.status, NEW._modify_user_id);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orders_status_history
    AFTER UPDATE OF status ON orders
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION fn_orders_status_history();

-- ── Generic row audit for privileged/sensitive tables ────────────────────────
-- Actor is read from the per-transaction setting app.user_id, which services
-- set via  SET LOCAL app.user_id = '<id>'  at the start of privileged writes.
-- Pass the PK column name as the trigger argument.

CREATE FUNCTION fn_audit_row() RETURNS trigger AS $$
DECLARE
    actor BIGINT;
    pk    TEXT;
BEGIN
    BEGIN
        actor := NULLIF(current_setting('app.user_id', TRUE), '')::BIGINT;
    EXCEPTION WHEN OTHERS THEN
        actor := NULL;
    END;
    IF TG_OP = 'DELETE' THEN
        pk := to_jsonb(OLD) ->> TG_ARGV[0];
        INSERT INTO audit_log (actor_user_id, action, entity, entity_id, old_data)
        VALUES (actor, TG_OP, TG_TABLE_NAME, pk, to_jsonb(OLD));
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        pk := to_jsonb(NEW) ->> TG_ARGV[0];
        INSERT INTO audit_log (actor_user_id, action, entity, entity_id, old_data, new_data)
        VALUES (actor, TG_OP, TG_TABLE_NAME, pk, to_jsonb(OLD), to_jsonb(NEW));
        RETURN NEW;
    ELSE
        pk := to_jsonb(NEW) ->> TG_ARGV[0];
        INSERT INTO audit_log (actor_user_id, action, entity, entity_id, new_data)
        VALUES (actor, TG_OP, TG_TABLE_NAME, pk, to_jsonb(NEW));
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_product_variants
    AFTER INSERT OR UPDATE OR DELETE ON product_variants
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row('variant_no');

CREATE TRIGGER trg_audit_user_roles
    AFTER INSERT OR DELETE ON user_roles
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row('user_id');

CREATE TRIGGER trg_audit_refunds
    AFTER INSERT OR UPDATE ON refunds
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row('refund_no');

CREATE TRIGGER trg_audit_shipping_rules
    AFTER INSERT OR UPDATE OR DELETE ON shipping_rules
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row('rule_no');

CREATE TRIGGER trg_audit_tax_rates
    AFTER INSERT OR UPDATE OR DELETE ON tax_rates
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row('rate_no');

CREATE TRIGGER trg_audit_app_settings
    AFTER INSERT OR UPDATE OR DELETE ON app_settings
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row('key');

CREATE TRIGGER trg_audit_warehouses
    AFTER INSERT OR UPDATE OR DELETE ON warehouses
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row('warehouse_no');
