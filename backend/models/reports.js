'use strict';

const { DB: db } = require('../common/db');

/**
 * Rollup maintenance for the daily_sales_facts table.
 *
 * NOT a report: reports live as self-contained controllers in
 * controllers/reports/ (discovered by services/reporting/registry). This
 * model only feeds them — the nightly job recomputes recent fact rows here,
 * and the sales reports read from the table.
 */
const Reports = (function () {

    return { rollupDay };

    /** Recomputes one day's rollup row (idempotent — used by the nightly job). */
    function rollupDay(day) {
        return db.query('SELECT fn_rollup_daily_sales($1::date)', [day]);
    }

}());

module.exports = Reports;
