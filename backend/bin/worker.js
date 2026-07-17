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
const { log } = require('../common/logger');

Jobs.start()
    .then(() => log('info', 'worker up', { pid: process.pid }))
    .catch(err => {
        log('error', 'worker failed to start', { error: err });
        process.exit(1);
    });

async function shutdown(signal) {
    log('info', 'worker shutting down', { signal });
    await Jobs.stop();
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
