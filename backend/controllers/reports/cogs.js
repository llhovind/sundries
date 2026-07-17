'use strict';

const { DB: db } = require('../../common/db');
const { isoToday, isoDaysAgo } = require('../../services/reporting/dates');

/**
 * Cost of goods sold over a period, grouped. All cost figures come straight
 * off the immutable ledger (unit_cost is stamped at issue time by the FIFO
 * trigger), so COGS is plain arithmetic — nothing here recomputes costing.
 */

const GROUPS = {
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

module.exports = {
    slug:     'cogs',
    name:     'COGS & margin',
    descr:    'FIFO cost of goods sold, revenue, and gross margin',
    category: 'finance',
    mode:     'immediate',
    params: [
        { name: 'from',     label: 'From',     type: 'date',   default: () => isoDaysAgo(30) },
        { name: 'to',       label: 'To',       type: 'date',   default: isoToday },
        { name: 'group_by', label: 'Group by', type: 'select',
          options: Object.keys(GROUPS), default: 'product' },
    ],
    columns: [
        { key: 'group_label',  label: 'Group',        format: 'text' },
        { key: 'units_sold',   label: 'Units sold',   format: 'qty' },
        { key: 'revenue',      label: 'Revenue',      format: 'money' },
        { key: 'cogs',         label: 'COGS',         format: 'money' },
        { key: 'gross_margin', label: 'Gross margin', format: 'money' },
    ],

    run({ from, to, group_by }) {
        const g = GROUPS[group_by];
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
    },
};
