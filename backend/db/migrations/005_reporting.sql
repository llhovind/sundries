-- ============================================================================
-- 005_reporting.sql
-- Reporting infrastructure.
--
-- daily_sales_facts is a nightly rollup so period reports never aggregate
-- millions of ledger rows at request time. All sold-goods numbers derive from
-- the immutable inventory ledger (the same source as the COGS report), so the
-- rollup can always be rebuilt from scratch — it is a cache, not a record.
-- ============================================================================

CREATE TABLE daily_sales_facts (
    fact_date       DATE PRIMARY KEY,
    orders_placed   INTEGER        NOT NULL DEFAULT 0,   -- excludes cancelled/failed
    units_sold      NUMERIC(16, 4) NOT NULL DEFAULT 0,   -- base-UOM units on sales OUT rows
    revenue         NUMERIC(14, 2) NOT NULL DEFAULT 0,   -- Σ(-qty × unit_price) on sales OUT rows
    cogs            NUMERIC(14, 2) NOT NULL DEFAULT 0,   -- Σ(-qty × unit_cost)  on sales OUT rows
    shrinkage_cost  NUMERIC(14, 2) NOT NULL DEFAULT 0,   -- Σ(-qty × unit_cost)  on negative ADJ rows
    _modify_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Recomputes one day's facts from source tables (idempotent upsert). The
-- nightly job re-rolls the last few days so late webhooks and corrections
-- are absorbed; a full rebuild is just calling this per day.
CREATE FUNCTION fn_rollup_daily_sales(p_day DATE) RETURNS void AS $$
    INSERT INTO daily_sales_facts
        (fact_date, orders_placed, units_sold, revenue, cogs, shrinkage_cost, _modify_ts)
    SELECT
        p_day,
        (SELECT COUNT(*) FROM orders o
          WHERE o.placed_at >= p_day AND o.placed_at < p_day + 1
            AND o.status NOT IN ('cancelled', 'payment_failed')),
        COALESCE(SUM(CASE WHEN t._trn_type = 'OUT' AND t._lnk_table = 'orders'
                          THEN -t.qty END), 0),
        COALESCE(SUM(CASE WHEN t._trn_type = 'OUT' AND t._lnk_table = 'orders'
                          THEN -t.qty * t.unit_price END), 0),
        COALESCE(SUM(CASE WHEN t._trn_type = 'OUT' AND t._lnk_table = 'orders'
                          THEN -t.qty * t.unit_cost END), 0),
        COALESCE(SUM(CASE WHEN t._trn_type = 'ADJ' AND t.qty < 0
                          THEN -t.qty * t.unit_cost END), 0),
        NOW()
    FROM inventory_transactions t
    WHERE t._trn_dt >= p_day AND t._trn_dt < p_day + 1
    ON CONFLICT (fact_date) DO UPDATE SET
        orders_placed  = EXCLUDED.orders_placed,
        units_sold     = EXCLUDED.units_sold,
        revenue        = EXCLUDED.revenue,
        cogs           = EXCLUDED.cogs,
        shrinkage_cost = EXCLUDED.shrinkage_cost,
        _modify_ts     = NOW();
$$ LANGUAGE sql;
