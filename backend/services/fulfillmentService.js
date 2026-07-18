'use strict';

const { withTransaction } = require('../common/db');
const Orders          = require('../models/orders');
const Shipments       = require('../models/shipments');
const PaymentsService = require('./paymentsService');
const { log } = require('../common/logger');

/**
 * FulfillmentService — ship-side orchestration (capture-on-fulfillment).
 *
 * shipOrder ships every line currently 'reserved' and runs its steps in
 * strict dependency order:
 *   1. Validate the order is shippable and has lines ready BEFORE any money
 *      moves — capturing a payment against an order that cannot ship is the
 *      worst failure mode.
 *   2. Capture the authorized payment. Idempotent (see PaymentsService), so
 *      a ship that crashed after capture — or a second shipment of an order
 *      whose backorders have now arrived — proceeds cleanly.
 *   3. Transition lines + order in one transaction. Backordered lines left
 *      outstanding make the order 'partially_shipped'; when the restock job
 *      fills them (line → 'reserved'), shipping again completes the order.
 *      The guarded UPDATE makes a concurrent double-ship lose with a 409.
 *   4. Enqueue the customer's shipped email only after state is durable.
 *
 * Capture policy: the full authorized amount is captured at the FIRST
 * shipment — a manual-capture intent allows exactly one capture, so partial
 * captures per shipment would forfeit the remainder.
 */
const FulfillmentService = (function () {

    const SHIPPABLE_STATUSES = ['paid', 'processing', 'partially_shipped'];

    return { shipOrder };

    /**
     * @param {number} ordNo
     * @param {number} actorUserId - staff member driving the ship (orders:fulfill)
     * @param {{carrier?:string, tracking_no?:string, notes?:string}} [details]
     *        package details for this ship event; all optional (tracking can
     *        be added later via Shipments.updateTracking)
     * @returns {Promise<{ord_no:number, status:'shipped'|'partially_shipped', shipment_no:number}>}
     */
    async function shipOrder(ordNo, actorUserId, details = {}) {
        const shipmentDetails = Shipments.validateDetails(details);
        const order = await Orders.findOne(ordNo, { staff: true });
        if (!order) {
            throw Object.assign(new Error('Order not found'), { status: 404 });
        }
        if (!SHIPPABLE_STATUSES.includes(order.status)) {
            throw Object.assign(
                new Error(`Order is not in a shippable state (status '${order.status}')`),
                { status: 409 });
        }
        if (!order.lines.some(l => l.fulfillment_status === 'reserved')) {
            throw Object.assign(
                new Error('No lines are ready to ship (backordered items are still awaiting stock)'),
                { status: 409 });
        }

        await PaymentsService.captureForOrder(ordNo);

        const result = await withTransaction(async (client) => {
            const shippedLines = await Orders.markLinesShipped(ordNo, client);
            const left = await client.query(
                `SELECT 1 FROM order_lines
                 WHERE _ord_no = $1 AND fulfillment_status = 'backordered' LIMIT 1`, [ordNo]);
            const target = left.rows.length ? 'partially_shipped' : 'shipped';
            const ok = await Orders.setStatus(ordNo, target, SHIPPABLE_STATUSES, actorUserId, client);
            if (!ok) return null;
            const shipmentNo = await Shipments.create(client, {
                ordNo, shippedBy: actorUserId, ...shipmentDetails, lines: shippedLines,
            });
            return { status: target, shipmentNo };
        });
        if (!result) {
            // Raced by another ship request after our read. Capture is
            // idempotent, so the winner's flow owns the transition.
            throw Object.assign(new Error('Order is not in a shippable state'), { status: 409 });
        }

        const Jobs = require('./jobs');   // lazy: jobs' handlers require services
        Jobs.send(Jobs.QUEUES.EMAIL, {
            event: 'order_shipped',
            order: {
                ord_no: order.ord_no, total: order.total, currency: order.currency,
                shipment: shipmentDetails,
            },
            to: order.email,
        }).catch(err => log('warn', 'order_shipped email enqueue failed', { ord_no: ordNo, error: err.message }));

        return { ord_no: ordNo, status: result.status, shipment_no: result.shipmentNo };
    }

}());

module.exports = FulfillmentService;
