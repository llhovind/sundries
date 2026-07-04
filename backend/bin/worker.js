#!/usr/bin/env node
'use strict';

/**
 * Standalone job worker — run one or more of these on dedicated instances in
 * cloud deployments (with JOBS_INLINE=false on the API fleet). Small installs
 * don't need it: the API runs jobs inline by default.
 *
 * Usage: npm run worker
 */

require('../common/config');   // validates env, throws early if incomplete
const Jobs = require('../services/jobs');

Jobs.start()
    .then(() => process.stdout.write(JSON.stringify({
        level: 'info', msg: 'worker up', pid: process.pid, ts: new Date().toISOString(),
    }) + '\n'))
    .catch(err => {
        console.error('Worker failed to start:', err.message);
        process.exit(1);
    });

async function shutdown(signal) {
    process.stdout.write(JSON.stringify({
        level: 'info', msg: `worker shutting down (${signal})`, ts: new Date().toISOString(),
    }) + '\n');
    await Jobs.stop();
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
