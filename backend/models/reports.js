'use strict';

const { DB: db } = require('../common/db');

/**
 * Reporting queries. All cost figures come straight off the immutable ledger
 * (unit_cost is stamped at issue time by the FIFO trigger), so COGS is plain
 * arithmetic — nothing here recomputes costing.
 *
 * Date parameters are inclusive `from`, exclusive `to+1 day` semantics via
 * ::date casts; callers pass ISO dates.
 */
const Reports = (function () {

    const COGS_GROUPS = {
        product: {
            select: `p.product_no AS group_id, p.name AS group_label`,
            join:   `JOIN product_variants v ON v.variant_no = t._variant_no
                     JOIN products p         ON p.product_no = v._product_no`,
            group:  `p.product_no, p.name`,
            order:  `cogs DESC`,
        },
        category: {
            select: `c.id AS group_id, COALESCE(c.name, 'Uncategorized') AS group_label`,
            join:   `JOIN product_variants v ON v.variant_no = t._variant_no
                     LEFT JOIN product_categories pc ON pc._product_no = v._product_no
                     LEFT JOIN categories c          ON c.id = pc._category_id`,
            group:  `c.id, c.name`,
            order:  `cogs DESC`,
        },
        day: {
            select: `NULL::bigint AS group_id, TO_CHAR(date_trunc('day', t._trn_dt), 'YYYY-MM-DD') AS group_label`,
            join:   ``,
            group:  `date_trunc('day', t._trn_dt)`,
            order:  `group_label`,
        },
        month: {
            select: `NULL::bigint AS group_id, TO_CHAR(date_trunc('month', t._trn_dt), 'YYYY-MM') AS group_label`,
            join:   ``,
            group:  `date_trunc('month', t._trn_dt)`,
            order:  `group_label`,
        },
    };

    return { cogs, valuation, shrinkage, reservations, salesSummary, rollupDay };

    /**
     * Cost of goods sold over a period, grouped.
     *
     * @param {{from:string, to:string, groupBy?:'product'|'category'|'day'|'month'}} opts
     */
    function cogs({ from, to, groupBy = 'product' }) {
        const g = COGS_GROUPS[groupBy];
        if (!g) return Promise.reject(Object.assign(
            new Error(`group_by must be one of: ${Object.keys(COGS_GROUPS).join(', ')}`), { status: 400 }));

        return db.query(
            `SELECT ${g.select},
                    SUM(-t.qty)                 AS units_sold,
                    ROUND(SUM(-t.qty * t.unit_price), 2) AS revenue,
                    ROUND(SUM(-t.qty * t.unit_cost), 2)  AS cogs,
                    ROUND(SUM(-t.qty * (t.unit_price - t.unit_cost)), 2) AS gross_margin
             FROM inventory_transactions t
             ${g.join}
             WHERE t._trn_type = 'OUT' AND t._lnk_table = 'orders'
               AND t._trn_dt >= $1::date AND t._trn_dt < $2::date + 1
             GROUP BY ${g.group}
             ORDER BY ${g.order}`,
            [from, to]
        ).then(res => res.rows);
    }

    /**
     * Current inventory valuation from remaining FIFO layers, per warehouse.
     * Transport warehouses appear with in_transit = true — goods on trucks
     * are still on the books.
     */
    function valuation({ warehouseNo = null } = {}) {
        const params = [];
        let whClause = '';
        if (warehouseNo != null) {
            params.push(warehouseNo);
            whClause = `AND l._warehouse_no = $1`;
        }
        return db.query(
            `SELECT w.warehouse_no, w.code AS warehouse_code, w.name AS warehouse_name,
                    (w.wh_type = 'transport')            AS in_transit,
                    COUNT(DISTINCT l._variant_no)::int   AS variants,
                    SUM(l.qty_remaining)                 AS units_on_hand,
                    ROUND(SUM(l.qty_remaining * l.unit_cost), 2) AS value
             FROM inventory_cost_layers l
             JOIN warehouses w ON w.warehouse_no = l._warehouse_no
             WHERE l.qty_remaining > 0 ${whClause}
             GROUP BY w.warehouse_no
             ORDER BY w.priority, w.warehouse_no`,
            params
        ).then(res => res.rows);
    }

    /**
     * Shrinkage (write-offs) over a period, grouped by reason code —
     * remnants of measured goods, damage, count corrections.
     */
    function shrinkage({ from, to }) {
        return db.query(
            `SELECT COALESCE(t.reason_code, 'unspecified') AS reason,
                    COUNT(*)::int                          AS entries,
                    SUM(-t.qty)                            AS units,
                    ROUND(SUM(-t.qty * t.unit_cost), 2)    AS cost
             FROM inventory_transactions t
             WHERE t._trn_type = 'ADJ' AND t.qty < 0
               AND t._trn_dt >= $1::date AND t._trn_dt < $2::date + 1
             GROUP BY t.reason_code
             ORDER BY cost DESC`,
            [from, to]
        ).then(res => res.rows);
    }

    /**
     * Active reservations — stock currently held by in-flight checkouts.
     */
    function reservations() {
        return db.query(
            `SELECT r.reservation_no, r._ord_no, r.qty, r.expires_at, r._create_ts,
                    v.sku, p.name AS product_name, w.code AS warehouse_code
             FROM inventory_reservations r
             JOIN product_variants v ON v.variant_no = r._variant_no
             JOIN products p         ON p.product_no = v._product_no
             JOIN warehouses w       ON w.warehouse_no = r._warehouse_no
             WHERE r.status = 'active'
             ORDER BY r.expires_at`,
        ).then(res => res.rows);
    }

    /**
     * Period sales summary from the nightly rollup (cheap at any range).
     * Today's row may lag until the next rollup; the job re-rolls recent days.
     */
    function salesSummary({ from, to }) {
        return db.query(
            `SELECT fact_date, orders_placed, units_sold, revenue, cogs, shrinkage_cost,
                    ROUND(revenue - cogs, 2) AS gross_margin
             FROM daily_sales_facts
             WHERE fact_date >= $1::date AND fact_date <= $2::date
             ORDER BY fact_date`,
            [from, to]
        ).then(res => res.rows);
    }

    /** Recomputes one day's rollup row (idempotent — used by the nightly job). */
    function rollupDay(day) {
        return db.query('SELECT fn_rollup_daily_sales($1::date)', [day]);
    }

}());

module.exports = Reports;
