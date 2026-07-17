'use strict';

const { DB: db } = require('../common/db');

/**
 * Repository for report_runs — stored generations of scheduled and
 * long-running reports. Pure persistence: lifecycle orchestration (spawning,
 * notification) lives in services/reporting/runService.
 */
const ReportRuns = (function () {

    // Listing caps at the most recent runs; old snapshots stay queryable by
    // run_no but don't bloat the list payload.
    const LIST_LIMIT = 50;

    // Everything except the (potentially large) result payload.
    const SUMMARY_COLS =
        `run_no, report_slug, status, trigger, params, requested_by,
         row_count, error, _create_ts, started_at, finished_at`;

    // A run still 'running' after this long lost its runner process (crash,
    // OOM kill) — no legitimate report takes an hour against this schema.
    const STALE_RUNNING_MINUTES = 60;

    return { create, claim, complete, fail, failStale, listForReport, get };

    /**
     * @param {{slug:string, params:object, trigger:'manual'|'schedule', requestedBy:?number}} opts
     * @returns {Promise<object>} the queued run row
     */
    function create({ slug, params, trigger, requestedBy = null }) {
        return db.query(
            `INSERT INTO report_runs (report_slug, params, trigger, requested_by)
             VALUES ($1, $2, $3, $4)
             RETURNING ${SUMMARY_COLS}`,
            [slug, JSON.stringify(params), trigger, requestedBy]
        ).then(res => res.rows[0]);
    }

    /**
     * Atomically move a queued run to running. Returns null when the run is
     * missing or already claimed — makes double execution harmless.
     */
    function claim(runNo) {
        return db.query(
            `UPDATE report_runs
             SET status = 'running', started_at = NOW()
             WHERE run_no = $1 AND status = 'queued'
             RETURNING ${SUMMARY_COLS}`,
            [runNo]
        ).then(res => res.rows[0] || null);
    }

    /** @param {number} runNo @param {Array<object>} rows - the report output */
    function complete(runNo, rows) {
        return db.query(
            `UPDATE report_runs
             SET status = 'succeeded', result = $2, row_count = $3, finished_at = NOW()
             WHERE run_no = $1
             RETURNING ${SUMMARY_COLS}`,
            [runNo, JSON.stringify(rows), rows.length]
        ).then(res => res.rows[0]);
    }

    /** @param {number} runNo @param {string} message - stored for the run list */
    function fail(runNo, message) {
        return db.query(
            `UPDATE report_runs
             SET status = 'failed', error = $2, finished_at = NOW()
             WHERE run_no = $1
             RETURNING ${SUMMARY_COLS}`,
            [runNo, message]
        ).then(res => res.rows[0]);
    }

    /**
     * Fail runs whose runner process died without reporting back — called by
     * the hourly reaper job so the UI never shows a phantom "running" forever.
     *
     * @returns {Promise<number>} how many runs were reaped
     */
    function failStale() {
        return db.query(
            `UPDATE report_runs
             SET status = 'failed', finished_at = NOW(),
                 error = 'Run abandoned — the runner process died'
             WHERE status = 'running'
               AND started_at < NOW() - make_interval(mins => ${STALE_RUNNING_MINUTES})`,
        ).then(res => res.rowCount);
    }

    /** Most recent runs for a report — summaries only, no result payloads. */
    function listForReport(slug) {
        return db.query(
            `SELECT ${SUMMARY_COLS}
             FROM report_runs
             WHERE report_slug = $1
             ORDER BY _create_ts DESC
             LIMIT ${LIST_LIMIT}`,
            [slug]
        ).then(res => res.rows);
    }

    /** @returns {Promise<object|null>} full run row including result rows */
    function get(runNo) {
        return db.query(
            `SELECT ${SUMMARY_COLS}, result FROM report_runs WHERE run_no = $1`,
            [runNo]
        ).then(res => res.rows[0] || null);
    }

}());

module.exports = ReportRuns;
