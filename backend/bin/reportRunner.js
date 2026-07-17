#!/usr/bin/env node
'use strict';

/**
 * Detached report-run subprocess — spawned by runService.startRun() so that
 * long-running reports (> 2 minutes) never block or die with an API request.
 * Claims one queued report_runs row, executes the report, stores the
 * snapshot, emails the requester, and exits.
 *
 * Usage: node bin/reportRunner.js <run_no>
 */

require('../common/config');   // validates env, throws early if incomplete

const { pool } = require('../common/db');
const RunService = require('../services/reporting/runService');
const { log } = require('../common/logger');

const runNo = parseInt(process.argv[2], 10);
if (isNaN(runNo)) {
    log('error', 'reportRunner needs a run_no argument');
    process.exit(1);
}

RunService.executeRun(runNo)
    .then(async (run) => {
        if (!run) log('warn', 'run already claimed or missing', { run_no: runNo });
        await pool.end();
        // executeRun records report failures on the run row itself; this
        // process succeeded either way at its job of executing the run.
        process.exit(0);
    })
    .catch(async (err) => {
        log('error', 'report runner crashed', { run_no: runNo, error: err.message });
        await pool.end().catch(() => {});
        process.exit(1);
    });
