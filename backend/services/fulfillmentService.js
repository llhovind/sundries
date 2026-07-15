'use strict';

const { withTransaction } = require('../common/db');
const Orders          = require('../models/orders');
const PaymentsService = require('./paymentsService');

function log(level, msg, extra = {}) {
    process.stdout.write(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }) + '\n');
}

/**
 * FulfillmentService — ship-side orchestration (capture-on-fulfillment).
 *
 * shipOrder runs its steps in strict dependency order:
 *   1. Validate the order is shippable BEFORE any money moves — capturing a
 *      payment against an order that cannot ship is the worst failure mode.
 *   2. Capture the authorized payment. Idempotent (see PaymentsService), so
 *      a ship that crashed after capture is recovered by re-running it.
 *   3. Transition order + lines in one transaction. The guarded UPDATE makes
 *      a concurrent double-ship lose cleanly with a 409.
 *   4. Enqueue the customer's shipped email only after state is durable.
 *
 * v1 boundary (extend here): ships the whole order — per-line/partial
 * shipments ('partially_shipped') are not implemented yet.
 */
const FulfillmentService = (function () {

    const SHIPPABLE_STATUSES = ['paid', 'processing'];

    return { shipOrder };

    /**
     * @param {number} ordNo
     * @param {number} actorUserId - staff member driving the ship (orders:fulfill)
     * @returns {Promise<{ord_no:number, status:'shipped'}>}
     */
    async function shipOrder(ordNo, actorUserId) {
        const order = await Orders.findOne(ordNo, { staff: true });
        if (!order) {
            throw Object.assign(new Error('Order not found'), { status: 404 });
        }
        if (!SHIPPABLE_STATUSES.includes(order.status)) {
            throw Object.assign(
                new Error(`Order is not in a shippable state (status '${order.status}')`),
                { status: 409 });
        }

        await PaymentsService.captureForOrder(ordNo);

        const updated = await withTransaction(async (client) => {
            const ok = await Orders.setStatus(ordNo, 'shipped', SHIPPABLE_STATUSES, actorUserId, client);
            if (ok) await Orders.markLinesShipped(ordNo, client);
            return ok;
        });
        if (!updated) {
            // Raced by another ship request after our read. Capture is
            // idempotent, so the winner's flow owns the transition.
            throw Object.assign(new Error('Order is not in a shippable state'), { status: 409 });
        }

        const Jobs = require('./jobs');   // lazy: jobs' handlers require services
        Jobs.send(Jobs.QUEUES.EMAIL, {
            event: 'order_shipped',
            order: { ord_no: order.ord_no, total: order.total, currency: order.currency },
            to: order.email,
        }).catch(err => log('warn', 'order_shipped email enqueue failed', { ord_no: ordNo, error: err.message }));

        return { ord_no: ordNo, status: 'shipped' };
    }

}());

module.exports = FulfillmentService;
