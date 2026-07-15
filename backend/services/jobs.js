'use strict';

const PgBoss = require('pg-boss');
const { pgConfig, DB: db } = require('../common/db');

function log(level, msg, extra = {}) {
    process.stdout.write(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }) + '\n');
}

/**
 * Jobs — pg-boss-backed background work. Postgres is the queue, so small
 * installs need zero extra infrastructure.
 *
 * Deployment modes:
 *   - inline (default): the API process runs the workers too — right for
 *     single-box shops. bin/www starts this unless JOBS_INLINE=false.
 *   - dedicated: run `npm run worker` on separate instances and set
 *     JOBS_INLINE=false on the API fleet — right for cloud scale.
 *
 * Scheduled work:
 *   reservation-sweep    every minute — release expired holds, fail stale orders
 *   search-outbox        every minute — drain catalog changes into the search index
 *   partition-maintenance daily 03:10 — pre-create ledger partitions when enabled
 *
 * Queued work (enqueued by services via Jobs.send):
 *   email        {event, order, to}   — order lifecycle mail through the mail port
 *   order-screen {ord_no}             — fraud velocity screening, post-placement
 *
 * Jobs.send falls back to executing the handler inline when the queue is not
 * running (JOBS_MODE=none, or before start) — a shop with no worker still
 * sends its emails, just synchronously.
 */
const Jobs = (function () {

    const QUEUES = {
        EMAIL:        'email',
        ORDER_SCREEN: 'order-screen',
        SWEEP:        'reservation-sweep',
        OUTBOX:       'search-outbox',
        PARTITION:    'partition-maintenance',
        ROLLUP:       'daily-rollup',
        COMPLIANCE:   'compliance-request',
    };

    // Handlers are lazy-required to avoid circular imports (paymentsService
    // enqueues jobs; the sweep job calls paymentsService).
    const HANDLERS = {
        [QUEUES.EMAIL]: async (data) => {
            const mailer = require('../common/mailer');
            await mailer.sendOrderEvent(data.event, data.order, data.to);
        },
        [QUEUES.ORDER_SCREEN]: async (data) => {
            const FraudService = require('./fraudService');
            const verdict = await FraudService.screenAndFlag(data.ord_no);
            if (verdict.flagged) log('warn', 'order flagged for review', { ord_no: data.ord_no, reasons: verdict.reasons });
        },
        [QUEUES.SWEEP]: async () => {
            const PaymentsService = require('./paymentsService');
            const { released, failed } = await PaymentsService.sweepExpired();
            if (released || failed) log('info', 'reservation sweep', { released, failed });
        },
        [QUEUES.OUTBOX]: async () => {
            const { getSearchProvider } = require('./search');
            const provider = await getSearchProvider();
            const { processed } = await provider.processOutbox();
            if (processed) log('info', 'search outbox drained', { processed, provider: provider.provider });
        },
        [QUEUES.COMPLIANCE]: async (data) => {
            const ComplianceService = require('./complianceService');
            await ComplianceService.process(data.id);
        },
        [QUEUES.ROLLUP]: async () => {
            // Re-roll the last 3 days so late payment webhooks and corrections
            // are absorbed; the function is an idempotent recompute per day.
            const Reports = require('../models/reports');
            for (let back = 0; back < 3; back++) {
                const day = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
                await Reports.rollupDay(day);
            }
            log('info', 'daily sales rollup complete', { days: 3 });
        },
        [QUEUES.PARTITION]: async () => {
            const Settings = require('../common/settings');
            const months = await Settings.getNumber('inventory.partition_months', -1);
            if (months < 0) return;   // scale-down mode: default partition only
            const res = await db.query('SELECT fn_ensure_inventory_partitions($1) AS created', [months]);
            if (res.rows[0].created) log('info', 'inventory partitions created', { created: res.rows[0].created });
        },
    };

    let boss = null;

    return { QUEUES, start, stop, send, isRunning: () => boss !== null };

    /**
     * Starts pg-boss, registers all workers, and installs the cron schedules.
     */
    async function start() {
        if (boss) return boss;
        const instance = new PgBoss({
            host:     pgConfig.host,
            port:     pgConfig.port,
            database: pgConfig.database,
            user:     pgConfig.user,
            password: pgConfig.password,
            ssl:      pgConfig.ssl,
            schema:   'pgboss',
            max:      3,                       // its own small pool
        });
        instance.on('error', err => log('error', 'pg-boss error', { error: err.message }));
        await instance.start();

        for (const q of Object.values(QUEUES)) {
            await instance.createQueue(q);
            await instance.work(q, { batchSize: 5 }, async (jobs) => {
                for (const job of jobs) {
                    try {
                        await HANDLERS[q](job.data || {});
                    } catch (err) {
                        log('error', 'job failed', { queue: q, jobId: job.id, error: err.message });
                        throw err;             // let pg-boss apply retry/backoff
                    }
                }
            });
        }

        await instance.schedule(QUEUES.SWEEP,     '* * * * *');
        await instance.schedule(QUEUES.OUTBOX,    '* * * * *');
        await instance.schedule(QUEUES.PARTITION, '10 3 * * *');
        await instance.schedule(QUEUES.ROLLUP,    '30 0 * * *');

        boss = instance;
        log('info', 'job runner started', { queues: Object.values(QUEUES) });
        return boss;
    }

    async function stop() {
        if (!boss) return;
        await boss.stop({ graceful: true });
        boss = null;
    }

    /**
     * Enqueue work. Falls back to inline execution when the queue is not
     * running so no install silently drops work.
     */
    async function send(queue, data = {}) {
        if (!HANDLERS[queue]) throw new Error(`Unknown job queue: ${queue}`);
        if (boss) {
            return boss.send(queue, data, { retryLimit: 3, retryDelay: 30, retryBackoff: true });
        }
        try {
            await HANDLERS[queue](data);
        } catch (err) {
            log('error', 'inline job execution failed', { queue, error: err.message });
        }
        return null;
    }

}());

module.exports = Jobs;
