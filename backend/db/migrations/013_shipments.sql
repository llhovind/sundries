-- ============================================================================
-- 013_shipments.sql
-- Shipment records for customer orders. Orders ship in one or more events
-- (partial shipments while backorders fill), so carrier/tracking live on a
-- per-event shipments row — never as columns on orders. shipment_lines pins
-- exactly which order lines left in which package.
--
-- Tracking data is deliberately mutable (labels are often printed after the
-- ship action); the rows themselves are never deleted.
-- ============================================================================

CREATE TABLE shipments (
    shipment_no  BIGSERIAL PRIMARY KEY,
    _ord_no      BIGINT NOT NULL REFERENCES orders ON DELETE CASCADE,
    carrier      TEXT,
    tracking_no  TEXT,
    notes        TEXT,
    shipped_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    shipped_by   BIGINT,                 -- staff user driving the ship
    _modify_ts   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _modify_user_id BIGINT
);
CREATE INDEX shipments_ord_idx ON shipments (_ord_no);

CREATE TABLE shipment_lines (
    id             BIGSERIAL PRIMARY KEY,
    _shipment_no   BIGINT NOT NULL REFERENCES shipments ON DELETE CASCADE,
    _order_line_id BIGINT NOT NULL REFERENCES order_lines,
    qty            NUMERIC(14, 4) NOT NULL CHECK (qty > 0),   -- snapshot at ship
    UNIQUE (_shipment_no, _order_line_id)
);
CREATE INDEX shipment_lines_shipment_idx ON shipment_lines (_shipment_no);
