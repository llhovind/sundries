'use strict';

const { DB: db, withTransaction } = require('../common/db');
const InventoryTransactions = require('../models/inventoryTransactions');

/**
 * StockTransferService
 *
 * Moves stock between warehouses through a transport warehouse so in-transit
 * goods stay visible and costed:
 *
 *   draft ──dispatch──▶ dispatched ──receive──▶ received
 *     └──cancel──▶ cancelled
 *
 * dispatch:  XFER_OUT @ from (FIFO cost stamped by trigger)
 *            XFER_IN  @ transport (carries that cost, creates a layer there)
 * receive:   XFER_OUT @ transport (consumes the transit layer)
 *            XFER_IN  @ to
 *
 * Each leg is one DB transaction; every movement is two immutable ledger rows
 * linked to the transfer document — the full audit trail falls out for free.
 * Carrier / manifest / billing identifiers live on the transfer (not the
 * warehouse) so any number of shipments can be in flight concurrently.
 */
const StockTransferService = (function () {

    return { create, dispatch, receive, cancel, findOne, list };

    /**
     * Creates a draft transfer with its lines.
     *
     * @param {object} data
     * @param {number} data.fromWarehouseNo
     * @param {number} data.toWarehouseNo
     * @param {number} data.transportWarehouseNo
     * @param {string} [data.carrier]
     * @param {string} [data.manifestId]
     * @param {string} [data.billingNo]
     * @param {string} [data.trackingNo]
     * @param {string} [data.notes]
     * @param {Array<{variantNo:number, qty:number}>} data.lines
     * @param {number} userId
     * @returns {Promise<number>} transfer_no
     */
    function create(data, userId) {
        const { fromWarehouseNo, toWarehouseNo, transportWarehouseNo,
                carrier, manifestId, billingNo, trackingNo, notes, lines = [] } = data;

        if (!fromWarehouseNo || !toWarehouseNo || !transportWarehouseNo) {
            return Promise.reject(new Error('from, to and transport warehouses are required'));
        }
        if (!lines.length) return Promise.reject(new Error('A transfer requires at least one line'));

        return withTransaction(async (client) => {
            const wh = await client.query(
                `SELECT warehouse_no, wh_type FROM warehouses
                 WHERE warehouse_no = ANY($1) AND status = 'active'`,
                [[fromWarehouseNo, toWarehouseNo, transportWarehouseNo]]
            );
            const types = new Map(wh.rows.map(r => [Number(r.warehouse_no), r.wh_type]));
            if (types.get(Number(transportWarehouseNo)) !== 'transport') {
                throw Object.assign(new Error('transportWarehouseNo must be an active transport warehouse'), { status: 400 });
            }
            if (types.get(Number(fromWarehouseNo)) !== 'standard' || types.get(Number(toWarehouseNo)) !== 'standard') {
                throw Object.assign(new Error('from/to must be active standard warehouses'), { status: 400 });
            }

            const res = await client.query(
                `INSERT INTO stock_transfers
                    (_from_warehouse_no, _to_warehouse_no, _transport_warehouse_no,
                     carrier, manifest_id, billing_no, tracking_no, notes,
                     _create_user_id, _modify_user_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
                 RETURNING transfer_no`,
                [fromWarehouseNo, toWarehouseNo, transportWarehouseNo,
                 carrier ?? null, manifestId ?? null, billingNo ?? null, trackingNo ?? null, notes ?? null,
                 userId]
            );
            const transferNo = res.rows[0].transfer_no;

            for (let i = 0; i < lines.length; i++) {
                await client.query(
                    `INSERT INTO stock_transfer_lines (_transfer_no, ln_no, _variant_no, qty)
                     VALUES ($1, $2, $3, $4)`,
                    [transferNo, i + 1, lines[i].variantNo, lines[i].qty]
                );
            }
            return transferNo;
        });
    }

    /**
     * Dispatches a draft transfer: stock leaves the origin and appears in the
     * transport warehouse at the same FIFO cost. Status guard makes a
     * concurrent double-dispatch a clean 409.
     */
    function dispatch(transferNo, userId) {
        return withTransaction(async (client) => {
            const t = await lockTransfer(client, transferNo, 'draft', 'dispatched');
            for (const ln of t.lines) {
                const out = await InventoryTransactions.create({
                    _trn_type: 'XFER_OUT',
                    _variant_no: ln._variant_no,
                    _warehouse_no: t._from_warehouse_no,
                    qty: -ln.qty,
                    _lnk_table: 'stock_transfers',
                    _lnk_id: transferNo,
                    _ln_no: ln.ln_no,
                }, userId, client);

                await InventoryTransactions.create({
                    _trn_type: 'XFER_IN',
                    _variant_no: ln._variant_no,
                    _warehouse_no: t._transport_warehouse_no,
                    qty: ln.qty,
                    unit_cost: out.unit_cost,      // cost travels with the goods
                    _lnk_table: 'stock_transfers',
                    _lnk_id: transferNo,
                    _ln_no: ln.ln_no,
                }, userId, client);
            }
            await client.query(
                `UPDATE stock_transfers
                 SET status = 'dispatched', dispatched_at = NOW(), _modify_ts = NOW(), _modify_user_id = $2
                 WHERE transfer_no = $1`,
                [transferNo, userId]
            );
            return transferNo;
        });
    }

    /**
     * Receives a dispatched transfer at its destination: stock leaves the
     * transport warehouse and lands at the destination at the same cost.
     */
    function receive(transferNo, userId) {
        return withTransaction(async (client) => {
            const t = await lockTransfer(client, transferNo, 'dispatched', 'received');
            for (const ln of t.lines) {
                const out = await InventoryTransactions.create({
                    _trn_type: 'XFER_OUT',
                    _variant_no: ln._variant_no,
                    _warehouse_no: t._transport_warehouse_no,
                    qty: -ln.qty,
                    _lnk_table: 'stock_transfers',
                    _lnk_id: transferNo,
                    _ln_no: ln.ln_no,
                }, userId, client);

                await InventoryTransactions.create({
                    _trn_type: 'XFER_IN',
                    _variant_no: ln._variant_no,
                    _warehouse_no: t._to_warehouse_no,
                    qty: ln.qty,
                    unit_cost: out.unit_cost,
                    _lnk_table: 'stock_transfers',
                    _lnk_id: transferNo,
                    _ln_no: ln.ln_no,
                }, userId, client);
            }
            await client.query(
                `UPDATE stock_transfers
                 SET status = 'received', received_at = NOW(), _modify_ts = NOW(), _modify_user_id = $2
                 WHERE transfer_no = $1`,
                [transferNo, userId]
            );
            return transferNo;
        });
    }

    /**
     * Cancels a transfer that has not been dispatched (no stock has moved).
     */
    function cancel(transferNo, userId) {
        return db.query(
            `UPDATE stock_transfers
             SET status = 'cancelled', _modify_ts = NOW(), _modify_user_id = $2
             WHERE transfer_no = $1 AND status = 'draft'
             RETURNING transfer_no`,
            [transferNo, userId]
        ).then(res => {
            if (!res.rows[0]) {
                throw Object.assign(new Error('Only draft transfers can be cancelled'), { status: 409 });
            }
            return res.rows[0].transfer_no;
        });
    }

    function findOne(transferNo) {
        return Promise.all([
            db.query(
                `SELECT t.*,
                        wf.code AS from_code, wt.code AS to_code, wx.code AS transport_code
                 FROM stock_transfers t
                 JOIN warehouses wf ON wf.warehouse_no = t._from_warehouse_no
                 JOIN warehouses wt ON wt.warehouse_no = t._to_warehouse_no
                 JOIN warehouses wx ON wx.warehouse_no = t._transport_warehouse_no
                 WHERE t.transfer_no = $1`,
                [transferNo]
            ).then(res => res.rows[0] || null),
            db.query(
                `SELECT l.ln_no, l._variant_no, l.qty, v.sku, p.name AS product_name
                 FROM stock_transfer_lines l
                 JOIN product_variants v ON v.variant_no = l._variant_no
                 JOIN products p         ON p.product_no = v._product_no
                 WHERE l._transfer_no = $1
                 ORDER BY l.ln_no`,
                [transferNo]
            ).then(res => res.rows),
        ]).then(([transfer, lines]) => transfer ? { ...transfer, lines } : null);
    }

    function list({ status = null, limit = 50, offset = 0 } = {}) {
        const params  = [];
        let where     = '';
        if (status) {
            params.push(status);
            where = `WHERE t.status = $${params.length}`;
        }
        params.push(offset, limit);
        return db.query(
            `SELECT t.transfer_no, t.status, t.carrier, t.manifest_id, t.tracking_no,
                    t.dispatched_at, t.received_at, t._create_ts,
                    wf.code AS from_code, wt.code AS to_code,
                    COUNT(l.id)::int AS line_count,
                    COUNT(*) OVER()::int AS _total
             FROM stock_transfers t
             JOIN warehouses wf ON wf.warehouse_no = t._from_warehouse_no
             JOIN warehouses wt ON wt.warehouse_no = t._to_warehouse_no
             LEFT JOIN stock_transfer_lines l ON l._transfer_no = t.transfer_no
             ${where}
             GROUP BY t.transfer_no, wf.code, wt.code
             ORDER BY t._create_ts DESC
             OFFSET $${params.length - 1} LIMIT $${params.length}`,
            params
        ).then(res => {
            const total = res.rows.length ? res.rows[0]._total : 0;
            return { rows: res.rows.map(({ _total, ...r }) => r), total };
        });
    }

    // ── Private ────────────────────────────────────────────────────────────

    /**
     * Locks the transfer row, asserts the expected status, and returns the
     * transfer with its lines. Throws 404/409 with the offending state.
     */
    async function lockTransfer(client, transferNo, expectedStatus, targetStatus) {
        const res = await client.query(
            `SELECT transfer_no, status, _from_warehouse_no, _to_warehouse_no, _transport_warehouse_no
             FROM stock_transfers WHERE transfer_no = $1 FOR UPDATE`,
            [transferNo]
        );
        const t = res.rows[0];
        if (!t) throw Object.assign(new Error('Transfer not found'), { status: 404 });
        if (t.status !== expectedStatus) {
            throw Object.assign(
                new Error(`Cannot mark transfer ${targetStatus}: status is '${t.status}', expected '${expectedStatus}'`),
                { status: 409 }
            );
        }
        const lines = await client.query(
            `SELECT ln_no, _variant_no, qty FROM stock_transfer_lines
             WHERE _transfer_no = $1 ORDER BY ln_no`,
            [transferNo]
        );
        if (!lines.rows.length) {
            throw Object.assign(new Error('Transfer has no lines'), { status: 400 });
        }
        return { ...t, lines: lines.rows };
    }

}());

module.exports = StockTransferService;
