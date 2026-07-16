'use strict';

const { DB: db, withTransaction } = require('../common/db');
const InventoryService = require('./inventoryService');

/**
 * PurchasingService — purchase orders and receiving against them.
 *
 *   open ──receive (partial, repeatable)──▶ open
 *   open ──receive (all lines full)──────▶ received ──close──▶ closed
 *   open ──close (short-close)───────────▶ closed
 *   open ──cancel (nothing received)─────▶ cancelled
 *
 * Receiving writes IN ledger rows through InventoryService (FIFO layer per
 * receipt, linked 'purchaseorders'/po_no/ln_no) and advances the line's
 * qty_received in the same transaction — the ledger and the document can
 * never disagree. A short-close records that the remainder is not coming
 * (vendor stock-out) without faking receipts.
 *
 * v1 boundaries (extend when needed): lines are fixed once the PO is
 * created (cancel and re-raise to change them); over-shipments beyond
 * qty_ordered go through a manual inventory receive; freight on the header
 * is informational — no landed-cost allocation across lines.
 */
const PurchasingService = (function () {

    // Fixed-point compare for NUMERIC(14,4) quantities — pg returns floats.
    const toUnits = n => Math.round(Number(n) * 10000);
    const round2  = n => Number(n.toFixed(2));

    return { create, receive, close, cancel, findOne, list };

    /**
     * Creates an open PO with its lines. Subtotal is computed from the lines;
     * freight/adj are recorded as given.
     *
     * @param {object} data - { vendor_id, warehouse_no, vendor_ordno?, vendor_invno?,
     *                          po_dt?, freight?, adj?, adj_reason?, notes?,
     *                          lines: [{variant_no, qty, unit_cost}] }
     * @param {number} userId
     * @returns {Promise<number>} po_no
     */
    function create(data, userId) {
        const { vendor_id, warehouse_no, vendor_ordno, vendor_invno,
                po_dt, freight, adj, adj_reason, notes, lines = [] } = data;

        if (!vendor_id || !warehouse_no) {
            return Promise.reject(Object.assign(
                new Error('vendor_id and warehouse_no are required'), { status: 400 }));
        }
        if (!lines.length) {
            return Promise.reject(Object.assign(
                new Error('A purchase order requires at least one line'), { status: 400 }));
        }
        for (const ln of lines) {
            if (!ln.variant_no || !(Number(ln.qty) > 0) || !(Number(ln.unit_cost) >= 0)) {
                return Promise.reject(Object.assign(
                    new Error('Each line needs variant_no, a positive qty and a unit_cost'), { status: 400 }));
            }
        }

        return withTransaction(async (client) => {
            const vendor = await client.query(`SELECT id FROM vendors WHERE id = $1`, [vendor_id]);
            if (!vendor.rows.length) {
                throw Object.assign(new Error('Unknown vendor'), { status: 400 });
            }
            const wh = await client.query(
                `SELECT warehouse_no FROM warehouses
                 WHERE warehouse_no = $1 AND wh_type = 'standard' AND status = 'active'`,
                [warehouse_no]);
            if (!wh.rows.length) {
                throw Object.assign(
                    new Error('warehouse_no must be an active standard warehouse'), { status: 400 });
            }

            const subtotal = round2(lines.reduce(
                (sum, ln) => sum + Number(ln.qty) * Number(ln.unit_cost), 0));

            const res = await client.query(
                `INSERT INTO purchaseorders
                    (_vendor_id, _warehouse_no, vendor_ordno, vendor_invno, po_dt,
                     subtotal, freight, adj, adj_reason, notes,
                     _create_user_id, _modify_user_id)
                 VALUES ($1,$2,$3,$4,COALESCE($5, NOW()),$6,$7,$8,$9,$10,$11,$11)
                 RETURNING po_no`,
                [vendor_id, warehouse_no, vendor_ordno ?? null, vendor_invno ?? null, po_dt ?? null,
                 subtotal, freight ?? null, adj ?? null, adj_reason ?? null, notes ?? null, userId]
            );
            const poNo = res.rows[0].po_no;

            for (let i = 0; i < lines.length; i++) {
                await client.query(
                    `INSERT INTO purchaseorder_lines (_po_no, ln_no, _variant_no, qty_ordered, unit_cost)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [poNo, i + 1, lines[i].variant_no, lines[i].qty, lines[i].unit_cost]
                );
            }
            return poNo;
        });
    }

    /**
     * Receives quantities against PO lines. Partial receipts are normal —
     * a PO stays open until every line is fully received (then 'received').
     * Each receipt is an IN ledger row at the line's unit cost.
     *
     * @param {number} poNo
     * @param {Array<{po_line_id:number, qty:number}>} receipts
     * @param {number} userId
     */
    function receive(poNo, receipts = [], userId) {
        if (!receipts.length) {
            return Promise.reject(Object.assign(
                new Error('At least one receipt line is required'), { status: 400 }));
        }
        return withTransaction(async (client) => {
            const poRes = await client.query(
                `SELECT po_no, po_status, _warehouse_no FROM purchaseorders
                 WHERE po_no = $1 FOR UPDATE`, [poNo]);
            const po = poRes.rows[0];
            if (!po) throw Object.assign(new Error('Purchase order not found'), { status: 404 });
            if (po.po_status !== 'open') {
                throw Object.assign(
                    new Error(`Cannot receive against a '${po.po_status}' purchase order`), { status: 409 });
            }

            const received = [];
            for (const r of receipts) {
                if (!(Number(r.qty) > 0)) {
                    throw Object.assign(new Error('Receipt qty must be positive'), { status: 400 });
                }
                const lineRes = await client.query(
                    `SELECT id, ln_no, _variant_no, qty_ordered, qty_received, unit_cost
                     FROM purchaseorder_lines
                     WHERE id = $1 AND _po_no = $2 FOR UPDATE`,
                    [r.po_line_id, poNo]);
                const line = lineRes.rows[0];
                if (!line) throw Object.assign(
                    new Error(`Line ${r.po_line_id} does not belong to PO ${poNo}`), { status: 400 });

                const remaining = toUnits(line.qty_ordered) - toUnits(line.qty_received);
                if (toUnits(r.qty) > remaining) {
                    throw Object.assign(
                        new Error(`Receipt for line ${line.ln_no} exceeds the remaining ` +
                                  `quantity (${remaining / 10000} of ${line.qty_ordered})`),
                        { status: 409 });
                }

                const trn = await InventoryService.receiveStock({
                    variantNo:   line._variant_no,
                    warehouseNo: po._warehouse_no,
                    qty:         Number(r.qty),
                    unitCost:    Number(line.unit_cost),
                    lnkTable:    'purchaseorders',
                    lnkId:       poNo,
                    lnNo:        line.ln_no,
                }, userId, client);

                await client.query(
                    `UPDATE purchaseorder_lines SET qty_received = qty_received + $2 WHERE id = $1`,
                    [line.id, r.qty]);
                received.push({ po_line_id: Number(line.id), ln_no: line.ln_no, qty: Number(r.qty), trn_no: trn.trn_no });
            }

            // Fully received across every line → the document advances itself.
            const open = await client.query(
                `SELECT 1 FROM purchaseorder_lines
                 WHERE _po_no = $1 AND qty_received < qty_ordered LIMIT 1`, [poNo]);
            let poStatus = 'open';
            if (!open.rows.length) {
                await setStatus(client, poNo, 'received', ['open'], userId);
                poStatus = 'received';
            } else {
                await client.query(
                    `UPDATE purchaseorders SET _modify_ts = NOW(), _modify_user_id = $2 WHERE po_no = $1`,
                    [poNo, userId]);
            }
            return { po_no: poNo, po_status: poStatus, received };
        });
    }

    /**
     * Closes a PO: from 'received' (normal completion) or from 'open'
     * (short-close — the remainder is not coming). Receiving stops either way.
     */
    async function close(poNo, userId) {
        const ok = await withTransaction(client =>
            setStatus(client, poNo, 'closed', ['open', 'received'], userId));
        if (!ok) {
            throw Object.assign(new Error('Only open or received purchase orders can be closed'), { status: 409 });
        }
        return poNo;
    }

    /**
     * Cancels an open PO on which nothing has been received. A PO with
     * receipts is history — short-close it instead.
     */
    function cancel(poNo, userId) {
        return withTransaction(async (client) => {
            const rec = await client.query(
                `SELECT 1 FROM purchaseorder_lines
                 WHERE _po_no = $1 AND qty_received > 0 LIMIT 1`, [poNo]);
            if (rec.rows.length) {
                throw Object.assign(
                    new Error('This purchase order has receipts — close it instead of cancelling'),
                    { status: 409 });
            }
            const ok = await setStatus(client, poNo, 'cancelled', ['open'], userId);
            if (!ok) {
                throw Object.assign(new Error('Only open purchase orders can be cancelled'), { status: 409 });
            }
            return poNo;
        });
    }

    function findOne(poNo) {
        return Promise.all([
            db.query(
                `SELECT po.*, v.name AS vendor_name, w.code AS warehouse_code
                 FROM purchaseorders po
                 JOIN vendors v    ON v.id = po._vendor_id
                 JOIN warehouses w ON w.warehouse_no = po._warehouse_no
                 WHERE po.po_no = $1`,
                [poNo]
            ).then(res => res.rows[0] || null),
            db.query(
                `SELECT l.id, l.ln_no, l._variant_no, l.qty_ordered, l.qty_received, l.unit_cost,
                        pv.sku, p.name AS product_name, p.base_uom
                 FROM purchaseorder_lines l
                 JOIN product_variants pv ON pv.variant_no = l._variant_no
                 JOIN products p          ON p.product_no = pv._product_no
                 WHERE l._po_no = $1
                 ORDER BY l.ln_no`,
                [poNo]
            ).then(res => res.rows),
        ]).then(([po, lines]) => po ? { ...po, lines } : null);
    }

    function list({ status = null, vendorId = null, limit = 25, offset = 0 } = {}) {
        const params  = [];
        const clauses = [];
        if (status)   { params.push(status);   clauses.push(`po.po_status = $${params.length}`); }
        if (vendorId) { params.push(vendorId); clauses.push(`po._vendor_id = $${params.length}`); }
        const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
        params.push(offset, limit);
        return db.query(
            `SELECT po.po_no, po.po_status, po.po_dt, po.vendor_ordno, po.subtotal, po.freight,
                    v.name AS vendor_name, w.code AS warehouse_code,
                    COUNT(l.id)::int AS line_count,
                    COALESCE(SUM(l.qty_ordered), 0)  AS qty_ordered,
                    COALESCE(SUM(l.qty_received), 0) AS qty_received,
                    COUNT(*) OVER()::int AS _total
             FROM purchaseorders po
             JOIN vendors v    ON v.id = po._vendor_id
             JOIN warehouses w ON w.warehouse_no = po._warehouse_no
             LEFT JOIN purchaseorder_lines l ON l._po_no = po.po_no
             ${where}
             GROUP BY po.po_no, v.name, w.code
             ORDER BY po.po_dt DESC, po.po_no DESC
             OFFSET $${params.length - 1} LIMIT $${params.length}`,
            params
        ).then(res => ({
            rows: res.rows.map(({ _total, ...r }) => r),
            total: res.rows.length ? res.rows[0]._total : 0,
        }));
    }

    // ── Private ────────────────────────────────────────────────────────────

    function setStatus(client, poNo, toStatus, fromStatuses, userId) {
        return client.query(
            `UPDATE purchaseorders
             SET po_status = $2, _modify_ts = NOW(), _modify_user_id = $3
             WHERE po_no = $1 AND po_status = ANY($4)
             RETURNING po_no`,
            [poNo, toStatus, userId, fromStatuses]
        ).then(res => res.rows.length > 0);
    }

}());

module.exports = PurchasingService;
