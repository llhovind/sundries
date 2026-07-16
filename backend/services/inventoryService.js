'use strict';

const { DB: db, withTransaction } = require('../common/db');
const Settings = require('../common/settings');
const InventoryTransactions = require('../models/inventoryTransactions');

function log(level, msg, extra = {}) {
    process.stdout.write(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }) + '\n');
}

// Fallback when app_settings 'reservations.ttl_minutes' is absent/invalid.
const DEFAULT_RESERVATION_TTL_MINUTES = 15;

/**
 * Error thrown when one or more order lines cannot be reserved.
 * Carries per-line detail so the checkout flow can revert one step and let
 * the customer choose remove / backorder / notify-when-available per line.
 */
class ReservationError extends Error {
    /** @param {Array<{variant_no:number, qty:number, qty_available:number}>} failures */
    constructor(failures) {
        super('Insufficient stock for one or more items');
        this.name     = 'ReservationError';
        this.status   = 409;
        this.failures = failures;
    }
}

/**
 * InventoryService
 *
 * Orchestrates inventory workflows on top of database-enforced invariants:
 *   - balances/cost-layers are maintained by triggers on every ledger insert
 *   - reservation math runs in DB functions (fn_allocate_and_reserve etc.)
 *     so any number of API instances stay consistent
 *
 * Ordering rule (enforced by the on_hand >= reserved CHECK): whenever a
 * reservation is consumed and stock issued in the same transaction, the
 * reservation must be consumed BEFORE the OUT ledger row is inserted.
 */
const InventoryService = (function () {

    return {
        ReservationError,
        receiveStock,
        writeOff,
        adjust,
        reserveForOrder,
        releaseOrderReservations,
        consumeOrderReservations,
        expireReservations,
    };

    // ── Receipts & adjustments ─────────────────────────────────────────────

    /**
     * Receives stock (purchase receipt or manual receive). unit_cost is the
     * landed cost per base UOM and seeds a FIFO layer.
     */
    function receiveStock({ variantNo, warehouseNo, qty, unitCost,
                            enteredQty, enteredUom, lnkTable, lnkId, lnNo, notes }, userId, client) {
        if (!(qty > 0)) return Promise.reject(new Error('receiveStock qty must be positive'));
        return InventoryTransactions.create({
            _trn_type: 'IN',
            _variant_no: variantNo,
            _warehouse_no: warehouseNo,
            qty,
            unit_cost: unitCost,
            entered_qty: enteredQty,
            entered_uom: enteredUom,
            _lnk_table: lnkTable,
            _lnk_id: lnkId,
            _ln_no: lnNo,
            notes,
        }, userId, client);
    }

    /**
     * Writes stock off (remnants of measured goods, damage, shrinkage).
     * qty is entered positive; recorded as a negative ADJ. The FIFO trigger
     * stamps the true cost so write-offs appear in COGS/shrinkage reports.
     */
    function writeOff({ variantNo, warehouseNo, qty, reasonCode = 'remnant', notes }, userId, client) {
        if (!(qty > 0)) return Promise.reject(new Error('writeOff qty must be positive'));
        return InventoryTransactions.create({
            _trn_type: 'ADJ',
            _variant_no: variantNo,
            _warehouse_no: warehouseNo,
            qty: -qty,
            reason_code: reasonCode,
            notes,
        }, userId, client);
    }

    /**
     * Signed count adjustment. Positive adjustments (found stock) require a
     * unitCost to value the new FIFO layer.
     */
    function adjust({ variantNo, warehouseNo, qty, unitCost, reasonCode = 'count', notes }, userId, client) {
        return InventoryTransactions.create({
            _trn_type: 'ADJ',
            _variant_no: variantNo,
            _warehouse_no: warehouseNo,
            qty,
            unit_cost: qty > 0 ? unitCost : null,
            reason_code: reasonCode,
            notes,
        }, userId, client);
    }

    // ── Reservations (Place Order → payment confirmation window) ───────────

    /**
     * Reserves stock for every line of an order, all-or-nothing.
     *
     * Allocation walks standard warehouses in priority order inside
     * fn_allocate_and_reserve (no split shipments). On success each order
     * line is marked 'reserved' and stamped with its warehouse. On any
     * failure the whole transaction rolls back and a ReservationError is
     * thrown carrying {variant_no, qty, qty_available} per failing line so
     * the checkout can revert one step and prompt the customer.
     *
     * @param {number} ordNo
     * @param {Array<{orderLineId:number, variantNo:number, qty:number}>} lines
     * @param {number} userId
     * @param {number} [ttlMinutes] - explicit override (tests); omitted callers
     *                                get the admin-configured app_settings value
     * @param {object} [txClient] - pg client to join a caller-managed transaction
     *                              (checkout creates order + reservations atomically)
     * @returns {Promise<Array<{reservation_no:number, variant_no:number, warehouse_no:number, qty:number, expires_at:Date}>>}
     */
    function reserveForOrder(ordNo, lines, userId, ttlMinutes = null, txClient = null) {
        if (!lines || !lines.length) return Promise.reject(new Error('No lines to reserve'));

        const run = async (client) => {
            const ttl = ttlMinutes ?? await Settings.getNumber(
                'reservations.ttl_minutes', DEFAULT_RESERVATION_TTL_MINUTES);
            const reservations = [];
            const failures     = [];

            for (const line of lines) {
                const alloc = await client.query(
                    'SELECT fn_allocate_and_reserve($1, $2) AS warehouse_no',
                    [line.variantNo, line.qty]
                );
                const warehouseNo = alloc.rows[0].warehouse_no;

                if (warehouseNo == null) {
                    failures.push({ variantNo: line.variantNo, qty: line.qty });
                    continue;   // keep collecting so the customer sees every problem at once
                }

                const res = await client.query(
                    `INSERT INTO inventory_reservations
                        (_ord_no, _variant_no, _warehouse_no, qty, expires_at, _create_user_id)
                     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::INTERVAL, $6)
                     RETURNING reservation_no, _variant_no AS variant_no,
                               _warehouse_no AS warehouse_no, qty, expires_at`,
                    [ordNo, line.variantNo, warehouseNo, line.qty, ttl, userId]
                );

                if (line.orderLineId) {
                    await client.query(
                        `UPDATE order_lines
                         SET fulfillment_status = 'reserved', _warehouse_no = $2
                         WHERE id = $1`,
                        [line.orderLineId, res.rows[0].warehouse_no]
                    );
                }
                reservations.push(res.rows[0]);
            }

            if (failures.length) {
                // Enrich failures with current availability, then roll back everything.
                const avail = await client.query(
                    `SELECT b._variant_no, SUM(b.qty_on_hand - b.qty_reserved) AS qty_available
                     FROM inventory_balances b
                     JOIN warehouses w ON w.warehouse_no = b._warehouse_no
                     WHERE b._variant_no = ANY($1) AND w.wh_type = 'standard' AND w.status = 'active'
                     GROUP BY b._variant_no`,
                    [failures.map(f => f.variantNo)]
                );
                const availMap = new Map(avail.rows.map(r => [Number(r._variant_no), Number(r.qty_available)]));
                // pg returns BIGINT columns as strings — normalize before lookup
                throw new ReservationError(failures.map(f => ({
                    variant_no:    Number(f.variantNo),
                    qty:           f.qty,
                    qty_available: availMap.get(Number(f.variantNo)) || 0,
                })));
            }

            return reservations;
        };

        return txClient ? run(txClient) : withTransaction(run);
    }

    /**
     * Releases every active reservation on an order (payment cancelled or
     * failed) and returns affected order lines to 'pending'. Idempotent.
     */
    function releaseOrderReservations(ordNo, txClient = null) {
        const run = async (client) => {
            const res = await client.query(
                `SELECT reservation_no FROM inventory_reservations
                 WHERE _ord_no = $1 AND status = 'active'
                 FOR UPDATE SKIP LOCKED`,
                [ordNo]
            );
            for (const row of res.rows) {
                await client.query('SELECT fn_release_reservation($1, $2)', [row.reservation_no, 'released']);
            }
            await client.query(
                `UPDATE order_lines SET fulfillment_status = 'pending', _warehouse_no = NULL
                 WHERE _ord_no = $1 AND fulfillment_status = 'reserved'`,
                [ordNo]
            );
            return res.rows.length;
        };
        return txClient ? run(txClient) : withTransaction(run);
    }

    /**
     * Converts an order's active reservations into stock issues on payment
     * confirmation: each reservation is consumed, then a matching OUT ledger
     * row (FIFO-costed by trigger, selling price from the order line) is
     * written — one transaction for the whole order.
     */
    function consumeOrderReservations(ordNo, userId, txClient = null) {
        const run = async (client) => {
            const res = await client.query(
                `SELECT r.reservation_no, r._variant_no, r._warehouse_no, r.qty,
                        ol.ln_no, ol.unit_price, ol.entered_qty, ol.entered_uom
                 FROM inventory_reservations r
                 JOIN order_lines ol ON ol._ord_no = r._ord_no AND ol._variant_no = r._variant_no
                 WHERE r._ord_no = $1 AND r.status = 'active'
                 ORDER BY r.reservation_no
                 FOR UPDATE OF r`,
                [ordNo]
            );

            const issued = [];
            for (const row of res.rows) {
                // Consume FIRST so the on_hand >= reserved CHECK holds when the
                // OUT row's balance trigger fires.
                const ok = await client.query('SELECT fn_consume_reservation($1) AS ok', [row.reservation_no]);
                if (!ok.rows[0].ok) continue;   // raced by sweeper/another worker — skip

                const trn = await InventoryTransactions.create({
                    _trn_type: 'OUT',
                    _variant_no: row._variant_no,
                    _warehouse_no: row._warehouse_no,
                    qty: -row.qty,
                    unit_price: row.unit_price,
                    entered_qty: row.entered_qty,
                    entered_uom: row.entered_uom,
                    _lnk_table: 'orders',
                    _lnk_id: ordNo,
                    _ln_no: row.ln_no,
                }, userId, client);
                issued.push(trn);
            }

            // Recovery: the sweeper can expire a reservation in the instant
            // between the TTL and this webhook. A paid order must never carry
            // a phantom 'reserved' line with no stock issued — re-allocate on
            // the spot (the freed stock is usually still there), or demote
            // the line to a formal backorder for the restock job to fill.
            const orphaned = await client.query(
                `SELECT id, ln_no, _variant_no, qty, unit_price, entered_qty, entered_uom
                 FROM order_lines ol
                 WHERE ol._ord_no = $1 AND ol.fulfillment_status = 'reserved'
                   AND NOT EXISTS (
                       SELECT 1 FROM inventory_transactions t
                       WHERE t._lnk_table = 'orders' AND t._lnk_id = ol._ord_no
                         AND t._ln_no = ol.ln_no AND t._trn_type = 'OUT')
                 FOR UPDATE`,
                [ordNo]);

            for (const line of orphaned.rows) {
                const alloc = await client.query(
                    `SELECT fn_allocate_and_reserve($1, $2) AS warehouse_no`,
                    [line._variant_no, line.qty]);
                const warehouseNo = alloc.rows[0].warehouse_no;

                if (warehouseNo == null) {
                    // Freed stock was resold before payment confirmed — the
                    // honest state is a backorder, never an unissued 'reserved'.
                    await client.query(
                        `UPDATE order_lines
                         SET fulfillment_status = 'backordered', _warehouse_no = NULL
                         WHERE id = $1`, [line.id]);
                    log('warn', 'expired reservation could not be recovered at payment — line backordered',
                        { ord_no: Number(ordNo), ln_no: line.ln_no, variant_no: Number(line._variant_no) });
                    continue;
                }

                const resIns = await client.query(
                    `INSERT INTO inventory_reservations
                        (_ord_no, _variant_no, _warehouse_no, qty, expires_at, _create_user_id)
                     VALUES ($1, $2, $3, $4, NOW(), $5)
                     RETURNING reservation_no`,
                    [ordNo, line._variant_no, warehouseNo, line.qty, userId]);
                await client.query(
                    `SELECT fn_consume_reservation($1)`, [resIns.rows[0].reservation_no]);

                const trn = await InventoryTransactions.create({
                    _trn_type: 'OUT',
                    _variant_no: line._variant_no,
                    _warehouse_no: warehouseNo,
                    qty: -line.qty,
                    unit_price: line.unit_price,
                    entered_qty: line.entered_qty,
                    entered_uom: line.entered_uom,
                    _lnk_table: 'orders',
                    _lnk_id: ordNo,
                    _ln_no: line.ln_no,
                }, userId, client);
                await client.query(
                    `UPDATE order_lines SET _warehouse_no = $2 WHERE id = $1`,
                    [line.id, warehouseNo]);
                issued.push(trn);
                log('info', 'expired reservation recovered at payment', {
                    ord_no: Number(ordNo), ln_no: line.ln_no, warehouse_no: Number(warehouseNo) });
            }
            return issued;
        };
        return txClient ? run(txClient) : withTransaction(run);
    }

    /**
     * Releases every reservation past its TTL. Run from the scheduled sweeper.
     * Order-status reversal for affected orders is owned by the checkout
     * service (phase 4) — this only frees the stock.
     *
     * @returns {Promise<number>} count released
     */
    function expireReservations() {
        return db.query('SELECT fn_expire_reservations() AS released')
            .then(res => res.rows[0].released);
    }

}());

module.exports = InventoryService;
