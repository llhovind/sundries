'use strict';

const path = require('path');
const { fork } = require('child_process');

const registry        = require('./registry');
const { validateParams } = require('./reportParams');
const ReportRuns      = require('../../models/reportRuns');

const RUNNER_PATH = path.join(__dirname, '../../bin/reportRunner.js');

function log(level, msg, extra = {}) {
    process.stdout.write(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }) + '\n');
}

function reject(status, message) {
    throw Object.assign(new Error(message), { status });
}

/**
 * Run lifecycle for stored reports.
 *
 * Stored reports never execute inside an API request: generation may exceed
 * the HTTP timeout (the 2-minute rule), so startRun() persists a queued run
 * and spawns a detached subprocess (bin/reportRunner.js) that claims it,
 * executes the report, stores the snapshot, and notifies by email. Scheduled
 * generations reuse the same executeRun() inside the job worker — one code
 * path produces every stored run.
 */
const RunService = (function () {

    return { startRun, executeRun, runScheduled };

    /**
     * Queue a manual run and spawn the detached runner subprocess.
     * Params are validated NOW so the caller gets the 400, not the runner.
     *
     * @returns {Promise<object>} the queued run summary (no result yet)
     */
    async function startRun(slug, rawParams, requestedBy) {
        const def = registry.get(slug);
        if (!def) reject(404, `Unknown report: ${slug}`);
        if (def.mode !== 'stored') {
            reject(400, `${slug} is an immediate report — request its results directly`);
        }
        const params = validateParams(def.params, rawParams);
        const run = await ReportRuns.create({ slug, params, trigger: 'manual', requestedBy });

        spawnRunner(run.run_no);
        return run;
    }

    /**
     * Claim and execute a queued run — called by the runner subprocess and
     * by the scheduler worker. Safe to call twice: the second claim no-ops.
     * Execution errors are recorded on the run, never thrown to the caller;
     * infrastructure errors (claim/store failing) do propagate.
     *
     * @returns {Promise<object|null>} the finished run, or null if already claimed
     */
    async function executeRun(runNo) {
        const run = await ReportRuns.claim(runNo);
        if (!run) return null;

        const def = registry.get(run.report_slug);
        if (!def) {
            // Report file removed while a run was queued — fail the run, don't crash.
            const failed = await ReportRuns.fail(runNo, `Report no longer exists: ${run.report_slug}`);
            await notify(failed, null);
            return failed;
        }

        let finished;
        try {
            const rows = await def.run(validateParams(def.params, run.params));
            finished = await ReportRuns.complete(runNo, rows);
            log('info', 'report run succeeded', { run_no: runNo, report: def.slug, rows: rows.length });
        } catch (err) {
            finished = await ReportRuns.fail(runNo, err.message || 'Report execution failed');
            log('error', 'report run failed', { run_no: runNo, report: def.slug, error: err.message });
        }
        await notify(finished, def);
        return finished;
    }

    /**
     * Scheduled generation (job worker): queue a run with default params and
     * execute it in-process — the worker is already a background process, a
     * further subprocess would add nothing but overhead.
     */
    async function runScheduled(slug) {
        const def = registry.get(slug);
        if (!def) {
            // Stale pg-boss schedule for a removed report — log, don't throw into retries.
            log('warn', 'scheduled report no longer registered', { report: slug });
            return null;
        }
        const params = validateParams(def.params, {});
        const run = await ReportRuns.create({ slug, params, trigger: 'schedule', requestedBy: null });
        return executeRun(run.run_no);
    }

    function spawnRunner(runNo) {
        const child = fork(RUNNER_PATH, [String(runNo)], {
            detached: true,
            stdio:    'ignore',   // runner logs via its own stdout json → parent's is irrelevant when detached
        });
        child.unref();   // the API process must never wait on a report
        log('info', 'report runner spawned', { run_no: runNo, pid: child.pid });
    }

    /**
     * Completion notification. Manual runs notify the requester; scheduled
     * runs notify everyone holding the report's category permission. Mail
     * failure never fails the run — the outcome is already persisted and
     * visible in the runs list.
     */
    async function notify(run, def) {
        try {
            const mailer = require('../../common/mailer');
            const recipients = await resolveRecipients(run, def);
            const reportName = def ? def.name : run.report_slug;
            await Promise.all(recipients.map(to =>
                mailer.sendReportReady(to, { name: reportName, run_no: run.run_no, status: run.status, error: run.error })
            ));
        } catch (err) {
            log('error', 'report notification failed', { run_no: run.run_no, error: err.message });
        }
    }

    async function resolveRecipients(run, def) {
        if (run.requested_by != null) {
            const Users = require('../../models/users');
            const user = await Users.findById(run.requested_by);
            return user && user.email ? [user.email] : [];
        }
        if (!def) return [];
        const Rbac = require('../../models/rbac');
        const holders = await Rbac.findUsersWithPermission(registry.permissionFor(def));
        return holders.map(u => u.email);
    }

}());

module.exports = RunService;
