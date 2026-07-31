/**
 * pg-boss adapter contract test.
 *
 * Runs on node:test rather than Jest, deliberately. pg-boss v12 is ESM-only
 * and Jest's runtime rewrites dynamic import() to require(), so the real
 * package cannot be loaded there. Node loads it natively, which makes this the
 * one place the actual transport is exercised: a job is enqueued, picked up by
 * a worker, and completed.
 *
 * Needs a live Postgres — the same one the Jest suite uses. Run with:
 *   npm run test:queue
 *
 * The queue name is unique per run so a failed run never leaves work that a
 * later run picks up and miscounts.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../../common/config');   // validates env, throws early if incomplete

const adapter = require('../../services/queue/pgBossAdapter');
const { DB: db, pool } = require('../../common/db');

// Released once, after the last test: the app pool is a module singleton, so
// closing it inside a per-test hook would strand the tests that follow.
after(() => pool.end());

const QUEUE = `contract-test-${process.pid}-${Date.now()}`;

/** pg-boss polls; this bounds how long we wait for a job to surface. */
const DELIVERY_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 250;

/**
 * @param {() => boolean} predicate
 * @returns {Promise<boolean>} true once satisfied, false if the timeout wins
 */
async function waitFor(predicate) {
    const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return predicate();
}

test('given a job is enqueued when a worker is registered then pg-boss delivers it exactly once', async (t) => {
    const delivered = [];

    t.after(async () => {
        await adapter.stop();
        // Drop the throwaway queue's rows so repeated local runs don't grow
        // the pgboss schema without bound.
        await db.query('DELETE FROM pgboss.job WHERE name = $1', [QUEUE]).catch(() => {});
    });

    await adapter.start([
        { queue: QUEUE, handler: async data => { delivered.push(data); } },
    ]);
    assert.equal(adapter.isRunning(), true, 'adapter should report running after start');
    assert.equal(adapter.durable, true, 'pg-boss is a durable transport');

    const jobId = await adapter.send(QUEUE, { marker: 'hello' }, {
        retryLimit: 1, retryDelay: 1, retryBackoff: false,
    });
    assert.ok(jobId, 'a durable transport must return a job id');

    const arrived = await waitFor(() => delivered.length > 0);
    assert.ok(arrived, `job was not delivered within ${DELIVERY_TIMEOUT_MS}ms`);
    assert.deepEqual(delivered[0], { marker: 'hello' }, 'handler receives the job payload unwrapped');

    // The batch unwrapping in the adapter is the easiest thing to get wrong in
    // a way that silently double-processes; hold it still.
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS * 4));
    assert.equal(delivered.length, 1, 'job should be delivered exactly once');
});

test('given a handler throws then the job is retried rather than completed', async (t) => {
    const attempts = [];
    const queue = `${QUEUE}-retry`;

    t.after(async () => {
        await adapter.stop();
        await db.query('DELETE FROM pgboss.job WHERE name = $1', [queue]).catch(() => {});
    });

    await adapter.start([
        {
            queue,
            handler: async () => {
                attempts.push(Date.now());
                throw new Error('deliberate failure');
            },
        },
    ]);

    await adapter.send(queue, {}, { retryLimit: 2, retryDelay: 1, retryBackoff: false });

    const retried = await waitFor(() => attempts.length >= 2);
    assert.ok(retried, `handler was attempted ${attempts.length} time(s); expected a retry`);
});
