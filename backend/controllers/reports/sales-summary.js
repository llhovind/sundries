'use strict';

const { DB: db } = require('../../common/db');
const { isoToday, isoDaysAgo } = require('../../services/reporting/dates');

/**
 * Daily sales summary from the nightly rollup (cheap at any range). Today's
 * row may lag until the next rollup; the rollup job re-rolls recent days.
 *
 * Sales category deliberately shows the revenue side only — cost and margin
 * figures live in the finance category (see cogs.js), so roles with sales
 * access never see cost data.
 */
module.exports = {
    slug:     'sales-summary',
    name:     'Sales summary',
    descr:    'Orders, units, and revenue per day',
    category: 'sales',
    mode:     'immediate',
    params: [
        { name: 'from', label: 'From', type: 'date', default: () => isoDaysAgo(30) },
        { name: 'to',   label: 'To',   type: 'date', default: isoToday },
    ],
    columns: [
        { key: 'fact_date',     label: 'Date',    format: 'date' },
        { key: 'orders_placed', label: 'Orders',  format: 'int' },
        { key: 'units_sold',    label: 'Units',   format: 'qty' },
        { key: 'revenue',       label: 'Revenue', format: 'money' },
    ],

    run({ from, to }) {
        return db.query(
            `SELECT fact_date, orders_placed, units_sold, revenue
             FROM daily_sales_facts
             WHERE fact_date >= $1::date AND fact_date <= $2::date
             ORDER BY fact_date`,
            [from, to]
        ).then(res => res.rows);
    },
};
