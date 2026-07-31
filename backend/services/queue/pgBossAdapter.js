'use strict';

/**
 * pg-boss queue adapter — Postgres *is* the queue, so a small install needs
 * no extra infrastructure.
 *
 * pg-boss v12 is published as ESM only, so it is reached through a dynamic
 * `import()` inside start() rather than a top-level require. Two consequences
 * worth knowing:
 *
 *   - Nothing pays for loading it until a process actually starts the queue.
 *     An API process running with QUEUE_PROVIDER=inline, or any process that
 *     only ever enqueues, never pulls the package in at all.
 *   - Under a CommonJS module loader that cannot resolve ESM — Jest's runtime
 *     rewrites dynamic import() to require() — this throws. That is by design:
 *     tests drive the inline adapter, and the pg-boss contract is covered by
 *     tests/integration/queue.pgboss.test.mjs, which runs on node:test where
 *     the real package loads natively. loadPgBoss() turns the resulting
 *     ERR_REQUIRE_ESM into a message that says so.
 */

const { pgConfig } = require('../../common/db');
const { log } = require('../../common/logger');
const { DEFAULT_MAX_BATCH } = require('./index');

/** Dedicated schema so queue tables never collide with the app's own. */
const SCHEMA = 'pgboss';

/** pg-boss keeps its own pool; small, because it only polls and completes. */
const POOL_MAX = 3;

let boss = null;

/**
 * Resolves the ESM-only pg-boss package.
 *
 * @returns {Promise<Function>} the PgBoss constructor (a *named* export as of
 *          v12; it was the module's default export through v10)
 */
async function loadPgBoss() {
    try {
        const { PgBoss } = await import('pg-boss');
        return PgBoss;
    } catch (err) {
        if (err.code === 'ERR_REQUIRE_ESM') {
            throw new Error(
                'pg-boss is ESM-only and cannot be loaded by this module loader '
                + '(Jest rewrites dynamic import() to require()). Set QUEUE_PROVIDER=inline '
                + 'for tests, or exercise this adapter under node:test.',
                { cause: err },
            );
        }
        throw err;
    }
}

/**
 * Starts the queue, registers every consumer as a worker, and installs the
 * cron schedule for those that declare one.
 *
 * @param {import('./index').Consumer[]} consumers
 */
async function start(consumers) {
    if (boss) return;

    const PgBoss = await loadPgBoss();
    const instance = new PgBoss({
        host:     pgConfig.host,
        port:     pgConfig.port,
        database: pgConfig.database,
        user:     pgConfig.user,
        password: pgConfig.password,
        ssl:      pgConfig.ssl,
        schema:   SCHEMA,
        max:      POOL_MAX,
    });

    // pg-boss surfaces connection trouble here rather than by rejecting; left
    // unhandled it would take the process down as an unhandled 'error' event.
    instance.on('error', err => log('error', 'pg-boss error', { error: err.message }));
    await instance.start();

    for (const consumer of consumers) {
        await instance.createQueue(consumer.queue);
        await instance.work(
            consumer.queue,
            { batchSize: consumer.maxBatch || DEFAULT_MAX_BATCH },
            batch => runBatch(consumer, batch),
        );
        if (consumer.schedule) await instance.schedule(consumer.queue, consumer.schedule);
    }

    boss = instance;
}

/**
 * Unwraps a pg-boss batch into one handler call per job. Batching is a fetch
 * optimisation belonging to this adapter — handlers see a single job's data.
 *
 * A throw propagates so pg-boss applies the queue's retry policy; swallowing
 * it here would mark failed work complete.
 *
 * @param {import('./index').Consumer} consumer
 * @param {Array<{id: string, data: object}>} batch
 */
async function runBatch(consumer, batch) {
    for (const job of batch) {
        try {
            await consumer.handler(job.data || {});
        } catch (err) {
            log('error', 'job failed', { queue: consumer.queue, jobId: job.id, error: err.message });
            throw err;
        }
    }
}

async function stop() {
    if (!boss) return;
    // Graceful: let in-flight handlers finish rather than orphaning jobs in
    // 'active', where they stay until the maintenance sweep expires them.
    await boss.stop({ graceful: true });
    boss = null;
}

/**
 * @param {string} queue
 * @param {object} data
 * @param {import('./index').RetryPolicy} retry
 * @returns {Promise<string|null>} the pg-boss job id
 */
async function send(queue, data, retry) {
    return boss.send(queue, data, retry);
}

module.exports = {
    provider: 'pgboss',
    durable:  true,
    start,
    stop,
    send,
    isRunning: () => boss !== null,
};
