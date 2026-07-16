'use strict';

const { DB: db, withTransaction } = require('../common/db');
const InventoryTransactions = require('../models/inventoryTransactions');

function log(level, msg, extra = {}) {
    process.stdout.write(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }) + '\n');
}

/**
 * RestockService — what happens when stock becomes available.
 *
 * processArrivals() runs from the scheduled restock job (every minute, like
 * the reservation sweeper) and is fully idempotent, so it needs no event
 * wiring in the receive paths — PO receipts, manual receives, transfer
 * receipts and RMA restocks are all picked up on the next tick, and a
 * receive whose transaction rolled back is never acted on.
 *
 *   1. Backorder fulfillment — backordered lines on payment-confirmed
 *      orders ('paid'/'processing'/'partially_shipped') are allocated
 *      oldest-order-first, all-or-nothing per line (no split shipments,
 *      matching checkout). Allocation reuses the reservation machinery
 *      (allocate → consume → OUT row at the line's price) so the ledger,
 *      balances and audit trail are identical to the normal paid flow, and
 *      the line advances backordered → reserved, ready for the ship screen.
 *      When an order's last backordered line fills, fulfillment staff are
 *      emailed. Unpaid (pending_payment) orders are never allocated stock.
 *
 *   2. Back-in-stock notifications — pending stock_notifications whose
 *      variant has available stock are marked 'notified' (conditional
 *      UPDATE — at most once, safe under concurrent runs) and the customer
 *      is emailed through the job queue.
 *
 * v1 boundary: notifications have no unsubscribe link ('cancelled' exists
 * in the schema for support staff to set manually).
 */
const RestockService = (function () {

    return { processArrivals, fulfillBackorders, sendStockNotifications };

    async function processArrivals() {
        const fulfilled = await fulfillBackorders();
        const notified  = await sendStockNotifications();
        return { fulfilled, notified };
    }

    // ── Backorders ──────────────────────────────────────────────────────────

    async function fulfillBackorders() {
        // Candidates: the availability probe is a cheap pre-filter; the
        // authoritative check is fn_allocate_and_reserve inside the tx.
        const cand = await db.query(
            `SELECT ol.id, ol._ord_no, ol.ln_no, ol._variant_no, ol.qty,
                    ol.unit_price, ol.entered_qty, ol.entered_uom
             FROM order_lines ol
             JOIN orders o ON o.ord_no = ol._ord_no
             WHERE ol.fulfillment_status = 'backordered'
               AND o.status IN ('paid', 'processing', 'partially_shipped')
               AND EXISTS (
                   SELECT 1 FROM inventory_balances b
                   JOIN warehouses w ON w.warehouse_no = b._warehouse_no
                   WHERE b._variant_no = ol._variant_no
                     AND w.wh_type = 'standard' AND w.status = 'active'
                     AND b.qty_on_hand - b.qty_reserved >= ol.qty)
             ORDER BY o.placed_at, ol.id`);

        const filledOrders = new Set();
        let fulfilled = 0;

        for (const line of cand.rows) {
            try {
                const ok = await withTransaction(async (client) => {
                    // Serialize against concurrent runs and re-check state.
                    const lock = await client.query(
                        `SELECT id FROM order_lines
                         WHERE id = $1 AND fulfillment_status = 'backordered'
                         FOR UPDATE`, [line.id]);
                    if (!lock.rows.length) return false;

                    const alloc = await client.query(
                        `SELECT fn_allocate_and_reserve($1, $2) AS warehouse_no`,
                        [line._variant_no, line.qty]);
                    const warehouseNo = alloc.rows[0].warehouse_no;
                    if (warehouseNo == null) return false;   // raced away — next arrival

                    // Reserve-and-consume in one transaction: the consumed
                    // reservation row documents the allocation, and the OUT
                    // row issues the stock exactly like the paid-order flow.
                    const resIns = await client.query(
                        `INSERT INTO inventory_reservations
                            (_ord_no, _variant_no, _warehouse_no, qty, expires_at)
                         VALUES ($1, $2, $3, $4, NOW())
                         RETURNING reservation_no`,
                        [line._ord_no, line._variant_no, warehouseNo, line.qty]);
                    await client.query(
                        `SELECT fn_consume_reservation($1)`, [resIns.rows[0].reservation_no]);

                    await InventoryTransactions.create({
                        _trn_type: 'OUT',
                        _variant_no: line._variant_no,
                        _warehouse_no: warehouseNo,
                        qty: -line.qty,
                        unit_price: line.unit_price,
                        entered_qty: line.entered_qty,
                        entered_uom: line.entered_uom,
                        _lnk_table: 'orders',
                        _lnk_id: line._ord_no,
                        _ln_no: line.ln_no,
                    }, null, client);

                    await client.query(
                        `UPDATE order_lines
                         SET fulfillment_status = 'reserved', _warehouse_no = $2
                         WHERE id = $1`, [line.id, warehouseNo]);
                    return true;
                });
                if (ok) {
                    fulfilled += 1;
                    filledOrders.add(Number(line._ord_no));
                }
            } catch (err) {
                // One bad line must not stall the rest of the queue.
                log('error', 'backorder allocation failed', {
                    order_line_id: Number(line.id), ord_no: Number(line._ord_no), error: err.message });
            }
        }

        for (const ordNo of filledOrders) {
            const left = await db.query(
                `SELECT 1 FROM order_lines
                 WHERE _ord_no = $1 AND fulfillment_status = 'backordered' LIMIT 1`, [ordNo]);
            if (!left.rows.length) notifyReadyToShip(ordNo);
        }
        return fulfilled;
    }

    /** Every backordered line filled — tell fulfillment the order can ship. */
    function notifyReadyToShip(ordNo) {
        const Jobs   = require('./jobs');            // lazy: jobs' restock handler requires this module
        const Orders = require('../models/orders');
        const Rbac   = require('../models/rbac');
        Orders.findOne(ordNo, { staff: true })
            .then(order => {
                if (!order) return;
                const payload = { ord_no: order.ord_no, total: order.total, currency: order.currency };
                return Rbac.findUsersWithPermission('orders:fulfill').then(users => {
                    users.forEach(u =>
                        Jobs.send(Jobs.QUEUES.EMAIL, { event: 'backorder_ready', order: payload, to: u.email })
                            .catch(err => log('error', 'backorder_ready enqueue failed', { to: u.email, error: err.message })));
                });
            })
            .catch(err => log('error', 'notifyReadyToShip failed', { ord_no: ordNo, error: err.message }));
    }

    // ── Back-in-stock notifications ─────────────────────────────────────────

    async function sendStockNotifications() {
        const rows = await db.query(
            `SELECT n.id, n.email, v.sku, p.name
             FROM stock_notifications n
             JOIN product_variants v ON v.variant_no = n._variant_no
             JOIN products p         ON p.product_no = v._product_no
             WHERE n.status = 'pending'
               AND EXISTS (
                   SELECT 1 FROM inventory_balances b
                   JOIN warehouses w ON w.warehouse_no = b._warehouse_no
                   WHERE b._variant_no = n._variant_no
                     AND w.wh_type = 'standard' AND w.status = 'active'
                     AND b.qty_on_hand - b.qty_reserved > 0)`);

        const Jobs = require('./jobs');
        let notified = 0;
        for (const n of rows.rows) {
            // Claim first (at most one email per request, safe concurrently);
            // a lost email is recoverable, a spammed customer is not.
            const claimed = await db.query(
                `UPDATE stock_notifications
                 SET status = 'notified', notified_at = NOW()
                 WHERE id = $1 AND status = 'pending'
                 RETURNING id`, [n.id]);
            if (!claimed.rows.length) continue;
            notified += 1;
            Jobs.send(Jobs.QUEUES.EMAIL, {
                event: 'back_in_stock', to: n.email,
                product: { sku: n.sku, name: n.name },
            }).catch(err => log('error', 'back_in_stock enqueue failed', { to: n.email, error: err.message }));
        }
        return notified;
    }

}());

module.exports = RestockService;
