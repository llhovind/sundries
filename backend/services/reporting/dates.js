'use strict';

/**
 * Date helpers for report parameter defaults. UTC throughout — the ledger
 * and rollups are UTC-dated, so report windows must be too.
 */

const DAY_MS = 86400000;

/** @returns {string} today as YYYY-MM-DD */
function isoToday() {
    return new Date().toISOString().slice(0, 10);
}

/** @returns {string} n days ago as YYYY-MM-DD */
function isoDaysAgo(n) {
    return new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
}

/** @returns {string} the previous calendar month as YYYY-MM */
function previousMonth() {
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return prev.toISOString().slice(0, 7);
}

/**
 * First day of a month and first day of the next month — half-open range
 * for SQL `>= from AND < to` comparisons.
 *
 * @param {string} month - YYYY-MM
 * @returns {{from: string, to: string}} YYYY-MM-DD bounds
 */
function monthBounds(month) {
    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
    const to   = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    return { from, to };
}

module.exports = { isoToday, isoDaysAgo, previousMonth, monthBounds };
