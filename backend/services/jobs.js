'use strict';

const { getQueueProvider } = require('./queue');
const { DB: db } = require('../common/db');
const { log } = require('../common/logger');

/**
 * Jobs — the background work this shop does, and what runs it.
 *
 * This module owns the *domain* side of background work: which queues exist,
 * what each one does, and how often. It owns no transport. Delivery belongs to
 * a queue adapter behind services/queue (pg-boss by default, backed by
 * Postgres, so small installs need zero extra infrastructure).
 *
 * Deployment modes:
 *   - inline (default): the API process runs the workers too — right for
 *     single-box shops. bin/www starts this unless JOBS_INLINE=false.
 *   - dedicated: run `npm run worker` on separate instances and set
 *     JOBS_INLINE=false on the API fleet — right for cloud scale.
 *   - queue-less: QUEUE_PROVIDER=inline runs enqueued work on the caller's
 *     stack and runs no scheduled work at all.
 *
 * Scheduled work:
 *   reservation-sweep    every minute — release expired holds, fail stale orders
 *   restock-arrivals     every minute — fill backorders, send back-in-stock mail
 *   search-outbox        every minute — drain catalog changes into the search index
 *   partition-maintenance daily 03:10 — pre-create ledger partitions when enabled
 *   auth-token-purge     daily 03:40 — drop refresh tokens past forensic retention
 *   report-run-reaper    hourly    — fail report runs whose runner died
 *   report-<slug>        per report — stored reports declaring a cron
 *                        schedule are discovered from the report registry
 *                        and generated on their own schedule
 *
 * Queued work (enqueued by services via Jobs.send):
 *   email        {event, order, to}   — order lifecycle mail through the mail port
 *   order-screen {ord_no}             — fraud velocity screening, post-placement
 *
 * Jobs.send falls back to executing the handler inline when no durable queue
 * is running — a shop with no worker still sends its emails, just synchronously.
 */
const Jobs = (function () {

    const QUEUES = {
        EMAIL:        'email',
        ORDER_SCREEN: 'order-screen',
        SWEEP:        'reservation-sweep',
        RESTOCK:      'restock-arrivals',
        OUTBOX:       'search-outbox',
        PARTITION:    'partition-maintenance',
        ROLLUP:       'daily-rollup',
        COMPLIANCE:   'compliance-request',
        AUTH_PURGE:   'auth-token-purge',
        REPORT_REAP:  'report-run-reaper',
    };

    const EVERY_MINUTE = '* * * * *';

    /**
     * Cron schedule per recurring queue. A queue absent here is on-demand:
     * it exists, it has a worker, but nothing triggers it on a clock.
     */
    const SCHEDULES = {
        [QUEUES.SWEEP]:       EVERY_MINUTE,
        [QUEUES.RESTOCK]:     EVERY_MINUTE,
        [QUEUES.OUTBOX]:      EVERY_MINUTE,
        [QUEUES.PARTITION]:   '10 3 * * *',
        [QUEUES.ROLLUP]:      '30 0 * * *',
        [QUEUES.AUTH_PURGE]:  '40 3 * * *',
        [QUEUES.REPORT_REAP]: '20 * * * *',
    };

    /**
     * Retry policy for enqueued work. Applies to durable transports only —
     * there is nothing to retry from when work runs on the caller's stack.
     */
    const RETRY_POLICY = Object.freeze({ retryLimit: 3, retryDelay: 30, retryBackoff: true });

    /** Report runs are heavy and write to shared run rows — one at a time. */
    const REPORT_MAX_BATCH = 1;

    /** Days of sales re-rolled on each rollup; see the ROLLUP handler. */
    const ROLLUP_LOOKBACK_DAYS = 3;

    const MS_PER_DAY = 86400000;

    /** Sentinel for 'partitioning disabled'; see the PARTITION handler. */
    const PARTITIONS_DISABLED = -1;

    // Handlers are lazy-required to avoid circular imports (paymentsService
    // enqueues jobs; the sweep job calls paymentsService).
    const HANDLERS = {
        [QUEUES.EMAIL]: async (data) => {
            const mailer = require('../common/mailer');
            if (data.event === 'back_in_stock') {
                await mailer.sendBackInStock(data.to, data.product);
            } else if (data.event && data.event.startsWith('rma_')) {
                await mailer.sendRmaEvent(data.event, data.rma, data.to);
            } else {
                await mailer.sendOrderEvent(data.event, data.order, data.to);
            }
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
        [QUEUES.RESTOCK]: async () => {
            const RestockService = require('./restockService');
            const { fulfilled, notified } = await RestockService.processArrivals();
            if (fulfilled || notified) log('info', 'restock arrivals processed', { fulfilled, notified });
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
            // Re-roll the last few days so late payment webhooks and corrections
            // are absorbed; the function is an idempotent recompute per day.
            const Reports = require('../models/reports');
            for (let back = 0; back < ROLLUP_LOOKBACK_DAYS; back++) {
                const day = new Date(Date.now() - back * MS_PER_DAY).toISOString().slice(0, 10);
                await Reports.rollupDay(day);
            }
            log('info', 'daily sales rollup complete', { days: ROLLUP_LOOKBACK_DAYS });
        },
        [QUEUES.AUTH_PURGE]: async () => {
            const RefreshTokens = require('../models/refreshTokens');
            const { purged } = await RefreshTokens.purgeExpired();
            if (purged) log('info', 'expired refresh tokens purged', { purged });
        },
        [QUEUES.REPORT_REAP]: async () => {
            const ReportRuns = require('../models/reportRuns');
            const reaped = await ReportRuns.failStale();
            if (reaped) log('warn', 'abandoned report runs failed', { reaped });
        },
        [QUEUES.PARTITION]: async () => {
            const Settings = require('../common/settings');
            const months = await Settings.getNumber('inventory.partition_months', PARTITIONS_DISABLED);
            if (months < 0) return;   // scale-down mode: default partition only
            const res = await db.query('SELECT fn_ensure_inventory_partitions($1) AS created', [months]);
            if (res.rows[0].created) log('info', 'inventory partitions created', { created: res.rows[0].created });
        },
    };

    /** @type {import('./queue').QueueProvider|null} */
    let driver = null;

    return { QUEUES, start, stop, send, isRunning: () => driver !== null && driver.isRunning() };

    /**
     * Assembles the full set of queues, their handlers and their schedules.
     *
     * @returns {import('./queue').Consumer[]}
     */
    function buildConsumers() {
        const consumers = Object.values(QUEUES).map(queue => ({
            queue,
            handler:  HANDLERS[queue],
            schedule: SCHEDULES[queue],
        }));

        // Scheduled stored reports — one queue per report, discovered from the
        // registry so adding a scheduled report never touches this file. Lazy-
        // required like the handlers: the registry pulls in every report
        // controller.
        const reportRegistry = require('./reporting/registry');
        const RunService     = require('./reporting/runService');
        for (const def of reportRegistry.scheduled()) {
            consumers.push({
                queue:    `report-${def.slug}`,
                handler:  () => RunService.runScheduled(def.slug),
                schedule: def.schedule,
                maxBatch: REPORT_MAX_BATCH,
            });
            log('info', 'scheduled report registered', { report: def.slug, cron: def.schedule });
        }

        return consumers;
    }

    /**
     * Starts the configured queue transport and registers every consumer.
     * Idempotent: a second call while running is a no-op.
     */
    async function start() {
        if (driver && driver.isRunning()) return;

        const provider = getQueueProvider();
        const consumers = buildConsumers();
        await provider.start(consumers);
        driver = provider;

        log('info', 'job runner started', {
            provider: provider.provider,
            queues:   consumers.map(c => c.queue),
        });
    }

    async function stop() {
        if (!driver) return;
        await driver.stop();
        driver = null;
    }

    /**
     * Enqueue work. Falls back to inline execution when no durable queue is
     * running so no install silently drops work.
     *
     * @param {string} queue one of QUEUES
     * @param {object} data  job payload; must survive a JSON round-trip
     * @returns {Promise<string|null>} transport job id, or null when the work
     *          ran inline
     */
    async function send(queue, data = {}) {
        if (!HANDLERS[queue]) throw new Error(`Unknown job queue: ${queue}`);

        if (driver && driver.isRunning()) {
            // A durable transport owns the outcome from here: a send failure
            // is a real infrastructure fault and belongs to the caller.
            if (driver.durable) return driver.send(queue, data, RETRY_POLICY);
            return tolerateFailure(() => driver.send(queue, data, RETRY_POLICY), queue);
        }
        return tolerateFailure(() => HANDLERS[queue](data), queue);
    }

    /**
     * Runs work on the caller's stack, logging rather than rethrowing.
     *
     * Deliberate: every Jobs.send caller is a request path — placing an order,
     * shipping it — and none of them should fail because a confirmation email
     * bounced. The cost is that with no durable queue behind it, failed work
     * is lost after this log line.
     *
     * @param {() => Promise<unknown>} work
     * @param {string} queue for the log record
     * @returns {Promise<null>}
     */
    async function tolerateFailure(work, queue) {
        try {
            await work();
        } catch (err) {
            log('error', 'inline job execution failed', { queue, error: err.message });
        }
        return null;
    }

}());

module.exports = Jobs;
