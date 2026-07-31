'use strict';

/**
 * QueueProvider registry — the transport behind services/jobs.js.
 *
 * Selection: QUEUE_PROVIDER env (deployment-level, validated at startup in
 * common/config.js) → 'pgboss'. Unlike the mail and search registries there is
 * no app_settings fallback: swapping the queue transport is a deployment
 * decision, not something an admin should be able to do from the UI while
 * jobs are in flight.
 *
 * The port exists so that the queue technology stays replaceable and, just as
 * importantly, *loadable on its own terms* — pg-boss v12 is an ESM-only
 * package, and confining it behind this boundary means only the one adapter
 * that needs it ever reaches for it. See pgBossAdapter.js.
 *
 * ---------------------------------------------------------------------------
 * The port contract
 * ---------------------------------------------------------------------------
 *
 * @typedef {object} Consumer
 *   One queue and the work that drains it. Assembled by services/jobs.js,
 *   which owns *what* the work is; the adapter owns *how* it gets delivered.
 * @property {string} queue                          queue name
 * @property {(data: object) => Promise<void>} handler   invoked once per job
 * @property {string} [schedule]  cron expression for recurring work; absent on
 *                                on-demand queues
 * @property {number} [maxBatch]  how many jobs of this queue may be handed
 *                                over at once; defaults to DEFAULT_MAX_BATCH
 *
 * @typedef {object} RetryPolicy
 * @property {number}  retryLimit
 * @property {number}  retryDelay     seconds before the first retry
 * @property {boolean} retryBackoff   exponential rather than fixed delay
 *
 * @typedef {object} QueueProvider
 * @property {string} provider                                     adapter name
 * @property {boolean} durable
 *   Whether accepted work outlives the caller: persisted somewhere that will
 *   retry it. Callers use this to decide who owns a failure — with a durable
 *   transport a send error is an infrastructure fault worth propagating, while
 *   a non-durable one has already run the work on the caller's stack.
 * @property {(consumers: Consumer[]) => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {(queue: string, data: object, retry: RetryPolicy) => Promise<string|null>} send
 *   Resolves to a transport-assigned job id, or null when the transport does
 *   not identify jobs (the inline adapter).
 * @property {() => boolean} isRunning
 */

/** Jobs handed to a consumer at once when it declares no preference. */
const DEFAULT_MAX_BATCH = 5;

const ADAPTERS = {
    get pgboss() { return require('./pgBossAdapter'); },
    get inline() { return require('./inlineAdapter'); },
};

/** Valid QUEUE_PROVIDER values. common/config.js validates against this. */
const QUEUE_PROVIDERS = Object.keys(ADAPTERS);

/**
 * @returns {QueueProvider}
 * @throws {Error} when QUEUE_PROVIDER names an adapter that does not exist —
 *                 loud at startup beats a shop that quietly runs no jobs.
 */
function getQueueProvider() {
    const name = process.env.QUEUE_PROVIDER || 'pgboss';
    const adapter = ADAPTERS[name];
    if (!adapter) throw new Error(`Unknown queue provider: ${name}`);
    return adapter;
}

module.exports = { getQueueProvider, QUEUE_PROVIDERS, DEFAULT_MAX_BATCH };
