'use strict';

const { DB: db } = require('../../common/db');
const { previousMonth, monthBounds } = require('../../services/reporting/dates');

/**
 * Monthly sales report — generated automatically on the 1st of each month
 * for the month just ended, and kept as a reviewable snapshot (stored runs).
 * Owners get a consistent month-end record even when later corrections
 * change the live rollup.
 */
module.exports = {
    slug:     'monthly-sales',
    name:     'Monthly sales',
    descr:    'Month-end snapshot: orders, units, and revenue per day, with best sellers',
    category: 'sales',
    mode:     'stored',
    schedule: '0 6 1 * *',   // 06:00 UTC on the 1st — after the nightly rollup
    params: [
        { name: 'month', label: 'Month', type: 'month', default: previousMonth },
    ],
    columns: [
        { key: 'fact_date',     label: 'Date',        format: 'date' },
        { key: 'orders_placed', label: 'Orders',      format: 'int' },
        { key: 'units_sold',    label: 'Units',       format: 'qty' },
        { key: 'revenue',       label: 'Revenue',     format: 'money' },
        { key: 'top_product',   label: 'Best seller', format: 'text' },
    ],

    async run({ month }) {
        const { from, to } = monthBounds(month);
        const res = await db.query(
            `SELECT f.fact_date, f.orders_placed, f.units_sold, f.revenue,
                    (SELECT p.name
                     FROM inventory_transactions t
                     JOIN product_variants v ON v.variant_no = t._variant_no
                     JOIN products p         ON p.product_no = v._product_no
                     WHERE t._trn_type = 'OUT' AND t._lnk_table = 'orders'
                       AND t._trn_dt >= f.fact_date AND t._trn_dt < f.fact_date + 1
                     GROUP BY p.product_no, p.name
                     ORDER BY SUM(-t.qty) DESC
                     LIMIT 1) AS top_product
             FROM daily_sales_facts f
             WHERE f.fact_date >= $1::date AND f.fact_date < $2::date
             ORDER BY f.fact_date`,
            [from, to]
        );
        return res.rows;
    },
};
