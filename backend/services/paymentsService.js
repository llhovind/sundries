'use strict';

const { DB: db, withTransaction } = require('../common/db');
const { getProvider }  = require('./payments');
const InventoryService = require('./inventoryService');
const Orders           = require('../models/orders');
const Rbac             = require('../models/rbac');

function log(level, msg, extra = {}) {
    process.stdout.write(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }) + '\n');
}

/**
 * PaymentsService
 *
 * Owns the payments state machine. Webhooks are the source of truth:
 * browser redirects never change payment state here.
 *
 *   created ──authorized──▶ authorized ──captured──▶ captured ──refunded──▶ refunded
 *      │  └──failed──▶ failed        └──cancelled──▶ cancelled
 *      └──captured──▶ captured   (providers do not guarantee event order)
 *
 * On payment confirmation ('authorized', or 'captured' arriving straight
 * from 'created') the order's reservations are consumed (stock issues with
 * FIFO cost) and the order goes 'paid' — exactly once, keyed to the state
 * transition. Capture normally happens at fulfillment (capture-on-fulfillment
 * policy). Every provider event is stored raw and deduplicated in
 * payment_events — a replayed webhook is a no-op.
 */
const PaymentsService = (function () {

    return {
        createPaymentForOrder,
        handleWebhook,
        processEvent,
        captureForOrder,
        cancelOrder,
        refundOrder,
        sweepExpired,
    };

    // ── Intent creation (called by checkout, after the order tx commits) ───

    async function createPaymentForOrder(order, providerName) {
        const provider = getProvider(providerName);

        const payRes = await db.query(
            `INSERT INTO payments (_ord_no, provider, amount, currency, status)
             VALUES ($1, $2, $3, $4, 'created')
             RETURNING payment_no`,
            [order.ord_no, provider.provider, order.total, order.currency]
        );
        const paymentNo = payRes.rows[0].payment_no;

        // Deterministic idempotency key: a retried create for the same payment
        // row can never double-charge.
        const idempotencyKey = `ord-${order.ord_no}-pay-${paymentNo}`;
        const intent = await provider.createIntent({
            amount: Number(order.total),
            currency: order.currency,
            idempotencyKey,
            metadata: { ord_no: String(order.ord_no) },
        });

        await db.query(
            `UPDATE payments SET intent_ref = $2, idempotency_key = $3, _modify_ts = NOW()
             WHERE payment_no = $1`,
            [paymentNo, intent.intentRef, idempotencyKey]
        );

        return {
            payment_no: paymentNo,
            provider: provider.provider,
            intent_ref: intent.intentRef,
            client_secret: intent.clientSecret,
        };
    }

    // ── Webhook pipeline ────────────────────────────────────────────────────

    /** Entry point for POST /payments/webhook/:provider (raw body). */
    async function handleWebhook(providerName, headers, rawBody) {
        const provider = getProvider(providerName);
        const event    = await provider.verifyWebhook(headers, rawBody);
        if (!event) return { ignored: true };          // event type we don't consume
        return processEvent(provider.provider, event);
    }

    /**
     * Applies one normalized provider event atomically:
     * dedupe → payment transition → inventory/order effects → mark processed.
     */
    async function processEvent(providerName, event) {
        const result = await withTransaction(async (client) => {
            const ins = await client.query(
                `INSERT INTO payment_events (provider, provider_event_id, event_type, payload)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (provider, provider_event_id) DO NOTHING
                 RETURNING event_no`,
                [providerName, event.eventId, event.type, JSON.stringify(event.raw || event)]
            );
            if (ins.rows.length === 0) {
                return { duplicate: true };            // replay — already handled
            }
            const eventNo = ins.rows[0].event_no;

            const payRes = await client.query(
                `SELECT payment_no, _ord_no, status FROM payments
                 WHERE provider = $1 AND intent_ref = $2
                 FOR UPDATE`,
                [providerName, event.intentRef]
            );
            const payment = payRes.rows[0];
            if (!payment) {
                // Event for an intent we don't know (e.g. created in the provider
                // dashboard). Keep the event, flag it, move on.
                await client.query(
                    `UPDATE payment_events SET processed_at = NOW() WHERE event_no = $1`, [eventNo]);
                log('warn', 'payment event for unknown intent', { provider: providerName, intentRef: event.intentRef });
                return { orphan: true };
            }

            const ordNo   = payment._ord_no;
            let   outcome = 'noop';

            const setPayment = (to, from) => client.query(
                `UPDATE payments SET status = $2, _modify_ts = NOW()
                 WHERE payment_no = $1 AND status = ANY($3)
                 RETURNING payment_no`,
                [payment.payment_no, to, from]
            ).then(r => r.rows.length > 0);

            // Payment-confirmation effects: consume the order's reservations
            // (stock issues at FIFO cost) and advance the order. Runs exactly
            // once — it is keyed to the payment leaving 'created', which the
            // conditional setPayment UPDATEs serialize. Returns whether the
            // order actually became 'paid'.
            const applyPaidEffects = async () => {
                await InventoryService.consumeOrderReservations(ordNo, null, client);
                const paid = await Orders.setStatus(ordNo, 'paid', ['pending_payment'], null, client);
                if (!paid) {
                    // The money is confirmed but the order already left
                    // pending_payment (e.g. the TTL sweeper failed it first).
                    // Captured funds with no stock held needs a human: refund
                    // or reinstate — never swallow this.
                    log('error', 'payment confirmed for an order no longer pending_payment — manual review required',
                        { ord_no: ordNo, payment_no: payment.payment_no, event_type: event.type });
                }
                return Boolean(paid);
            };

            switch (event.type) {
                case 'authorized':
                    if (await setPayment('authorized', ['created'])) {
                        if (await applyPaidEffects()) outcome = 'paid';
                    }
                    break;
                case 'captured':
                    // Providers do not guarantee delivery order: a capture can
                    // arrive before — or without — the authorize event. When it
                    // moves the payment straight off 'created', the paid
                    // effects must still happen here; the late authorize event
                    // then finds the payment past 'created' and no-ops.
                    if (await setPayment('captured', ['created', 'authorized'])) {
                        outcome = 'captured';
                        if (payment.status === 'created' && await applyPaidEffects()) {
                            outcome = 'paid';
                        }
                    }
                    break;
                case 'failed':
                    if (await setPayment('failed', ['created', 'authorized'])) {
                        await InventoryService.releaseOrderReservations(ordNo, client);
                        await Orders.setStatus(ordNo, 'payment_failed', ['pending_payment'], null, client);
                        outcome = 'failed';
                    }
                    break;
                case 'cancelled':
                    if (await setPayment('cancelled', ['created', 'authorized'])) {
                        await InventoryService.releaseOrderReservations(ordNo, client);
                        await Orders.setStatus(ordNo, 'cancelled', ['pending_payment'], null, client);
                        outcome = 'cancelled';
                    }
                    break;
                case 'refunded':
                    if (await setPayment('refunded', ['captured'])) outcome = 'refunded';
                    break;
                default:
                    log('warn', 'unhandled payment event type', { type: event.type });
            }

            await client.query(
                `UPDATE payment_events SET processed_at = NOW(), _payment_no = $2 WHERE event_no = $1`,
                [eventNo, payment.payment_no]
            );
            return { outcome, ord_no: ordNo };
        });

        // Notifications after commit — never inside the transaction.
        if (result.outcome === 'paid') notifyPaid(result.ord_no);
        return result;
    }

    // ── Fulfillment capture / cancel / refund ───────────────────────────────

    /**
     * Capture-on-fulfillment: called by the ship flow (FulfillmentService),
     * which validates the order is shippable BEFORE any money moves. Direct
     * API call; the provider's 'captured' webhook is the authoritative
     * confirmation, but we optimistically transition so the UI reflects
     * reality.
     *
     * Idempotent: an already-captured payment (ship retried after a crash,
     * or the capture webhook won the race) is a no-op success, so
     * fulfillment can always be re-driven to completion.
     */
    async function captureForOrder(ordNo) {
        const payment = await findPaymentForOrder(ordNo, ['authorized', 'captured']);
        if (payment.status === 'captured') return payment.payment_no;
        const provider = getProvider(payment.provider);
        await provider.capture(payment.intent_ref);
        await db.query(
            `UPDATE payments SET status = 'captured', _modify_ts = NOW()
             WHERE payment_no = $1 AND status = 'authorized'`,
            [payment.payment_no]
        );
        return payment.payment_no;
    }

    /**
     * Customer/staff cancellation of a not-yet-paid order: void the intent
     * (best effort), release stock, transition the order.
     */
    async function cancelOrder(ordNo, actorUserId) {
        const updated = await withTransaction(async (client) => {
            const ok = await Orders.setStatus(ordNo, 'cancelled', ['pending_payment'], actorUserId, client);
            if (!ok) return null;
            await InventoryService.releaseOrderReservations(ordNo, client);
            return ok;
        });
        if (!updated) {
            throw Object.assign(new Error('Only orders awaiting payment can be cancelled'), { status: 409 });
        }
        try {
            const payment = await findPaymentForOrder(ordNo, ['created', 'authorized']);
            await getProvider(payment.provider).cancel(payment.intent_ref);
            await db.query(
                `UPDATE payments SET status = 'cancelled', _modify_ts = NOW()
                 WHERE payment_no = $1 AND status IN ('created','authorized')`,
                [payment.payment_no]
            );
        } catch (err) {
            // Stock is already safe; a dangling intent expires provider-side.
            log('warn', 'intent cancel failed after order cancel', { ord_no: ordNo, error: err.message });
        }
        return updated;
    }

    /**
     * Manual refund (Finance role — refunds:create). Records the refund,
     * executes it at the provider, and updates payment status.
     */
    async function refundOrder(ordNo, amount, reason, actorUserId) {
        if (!(amount > 0)) throw Object.assign(new Error('amount must be positive'), { status: 400 });
        if (!reason)       throw Object.assign(new Error('reason is required'), { status: 400 });

        const payment = await findPaymentForOrder(ordNo, ['captured', 'refunded', 'partially_refunded', 'authorized']);
        const refRes = await db.query(
            `INSERT INTO refunds (_payment_no, _ord_no, amount, reason, status, _create_user_id, _modify_user_id)
             VALUES ($1, $2, $3, $4, 'created', $5, $5)
             RETURNING refund_no`,
            [payment.payment_no, ordNo, amount, reason, actorUserId]
        );
        const refundNo = refRes.rows[0].refund_no;

        try {
            const r = await getProvider(payment.provider).refund(payment.intent_ref, amount);
            const partial = Number(amount) < Number(payment.amount);
            await withTransaction(async (client) => {
                await client.query(`SELECT set_config('app.user_id', $1, true)`, [String(actorUserId)]);
                await client.query(
                    `UPDATE refunds SET status = 'completed', provider_ref = $2, _modify_ts = NOW()
                     WHERE refund_no = $1`,
                    [refundNo, r.refundRef]
                );
                await client.query(
                    `UPDATE payments SET status = $2, _modify_ts = NOW() WHERE payment_no = $1`,
                    [payment.payment_no, partial ? 'partially_refunded' : 'refunded']
                );
            });
            return { refund_no: refundNo, status: 'completed' };
        } catch (err) {
            await db.query(
                `UPDATE refunds SET status = 'failed', _modify_ts = NOW() WHERE refund_no = $1`, [refundNo]);
            throw err;
        }
    }

    // ── TTL sweeper ─────────────────────────────────────────────────────────

    /**
     * Releases expired reservations, then fails orders whose payment never
     * confirmed within the TTL. Run every minute (cron / pg-boss).
     */
    async function sweepExpired() {
        const released = await InventoryService.expireReservations();

        const ttlRes = await db.query(
            `SELECT value FROM app_settings WHERE key = 'reservations.ttl_minutes'`);
        const ttl = ttlRes.rows.length ? Number(ttlRes.rows[0].value) : 15;

        const stale = await db.query(
            `SELECT ord_no FROM orders
             WHERE status = 'pending_payment'
               AND placed_at < NOW() - ($1 || ' minutes')::INTERVAL
               AND NOT EXISTS (
                   SELECT 1 FROM inventory_reservations r
                   WHERE r._ord_no = orders.ord_no AND r.status = 'active')`,
            [ttl]
        );
        let failed = 0;
        for (const row of stale.rows) {
            const ok = await Orders.setStatus(row.ord_no, 'payment_failed', ['pending_payment'], null);
            if (ok) {
                failed += 1;
                try {
                    const payment = await findPaymentForOrder(row.ord_no, ['created', 'authorized']);
                    await getProvider(payment.provider).cancel(payment.intent_ref);
                    await db.query(
                        `UPDATE payments SET status = 'cancelled', _modify_ts = NOW()
                         WHERE payment_no = $1 AND status IN ('created','authorized')`,
                        [payment.payment_no]);
                } catch (err) {
                    log('warn', 'sweep: intent cancel failed', { ord_no: row.ord_no, error: err.message });
                }
            }
        }
        return { released, failed };
    }

    // ── Private ─────────────────────────────────────────────────────────────

    async function findPaymentForOrder(ordNo, statuses) {
        const res = await db.query(
            `SELECT payment_no, _ord_no, provider, intent_ref, amount, currency, status
             FROM payments
             WHERE _ord_no = $1 AND status = ANY($2)
             ORDER BY payment_no DESC LIMIT 1`,
            [ordNo, statuses]
        );
        if (!res.rows.length) {
            throw Object.assign(
                new Error(`No payment in state [${statuses.join(', ')}] for order ${ordNo}`),
                { status: 409 });
        }
        return res.rows[0];
    }

    function notifyPaid(ordNo) {
        const Jobs = require('./jobs');   // lazy: jobs' sweep handler requires this module
        Orders.findOne(ordNo, { staff: true })
            .then(order => {
                if (!order) return;
                const payload = { ord_no: order.ord_no, total: order.total, currency: order.currency };
                Jobs.send(Jobs.QUEUES.EMAIL, { event: 'order_paid', order: payload, to: order.email })
                    .catch(err => log('error', 'customer order_paid enqueue failed', { ord_no: ordNo, error: err.message }));
                return Rbac.findUsersWithPermission('orders:fulfill').then(users => {
                    users.forEach(u =>
                        Jobs.send(Jobs.QUEUES.EMAIL, { event: 'new_order', order: payload, to: u.email })
                            .catch(err => log('error', 'fulfillment notification enqueue failed', { to: u.email, error: err.message })));
                });
            })
            .catch(err => log('error', 'notifyPaid failed', { ord_no: ordNo, error: err.message }));
    }

}());

module.exports = PaymentsService;
