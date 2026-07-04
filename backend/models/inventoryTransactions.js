'use strict';

const { DB: db } = require('../common/db');

/**
 * Repository for the immutable inventory ledger.
 *
 * Rows are append-only (enforced by a DB trigger). Quantities are SIGNED and
 * expressed in the product's base UOM: positive = stock in, negative = stock out.
 * DB triggers maintain inventory_balances and FIFO cost layers on every insert,
 * and stamp unit_cost onto issue rows — callers never compute FIFO themselves.
 */
const InventoryTransactions = (function () {

    const RECEIPT_TYPES = ['IN', 'RET', 'XFER_IN'];
    const ISSUE_TYPES   = ['OUT', 'XFER_OUT'];
    const ALL_TYPES     = [...RECEIPT_TYPES, ...ISSUE_TYPES, 'ADJ'];

    return { create, findForVariant, findForLink };

    /**
     * Appends one ledger row. unit_cost is required for receipts (qty > 0);
     * for issues it is computed by the FIFO trigger and returned here.
     *
     * @param {object} data
     * @param {string}      data._trn_type     - IN | OUT | RET | XFER_IN | XFER_OUT | ADJ
     * @param {number}      data._variant_no
     * @param {number}      data._warehouse_no
     * @param {number}      data.qty           - signed, in base UOM
     * @param {number|null} data.unit_cost     - required when qty > 0
     * @param {number|null} data.unit_price    - selling price (sales OUT rows)
     * @param {number|null} data.entered_qty   - provenance: qty as originally entered
     * @param {string|null} data.entered_uom
     * @param {string|null} data.reason_code   - e.g. 'remnant', 'damage', 'count'
     * @param {string|null} data._lnk_table    - 'orders' | 'purchaseorders' | 'stock_transfers' | 'rmas' | 'manual'
     * @param {number|null} data._lnk_id
     * @param {number|null} data._ln_no
     * @param {string|null} data.notes
     * @param {number} userId
     * @param {object} [client] - pg client to join a caller-managed transaction
     * @returns {Promise<{trn_no: number, unit_cost: number}>}
     */
    function create(data, userId, client) {
        const {
            _trn_type, _variant_no, _warehouse_no, qty,
            unit_cost, unit_price, entered_qty, entered_uom,
            reason_code, _lnk_table, _lnk_id, _ln_no, notes, _trn_dt
        } = data;

        if (!ALL_TYPES.includes(_trn_type)) throw new Error(`_trn_type must be one of ${ALL_TYPES.join(', ')}`);
        if (!_variant_no)   throw new Error('_variant_no is required');
        if (!_warehouse_no) throw new Error('_warehouse_no is required');
        if (qty == null || Number(qty) === 0) throw new Error('qty must be a non-zero signed number');
        if (RECEIPT_TYPES.includes(_trn_type) && qty <= 0) throw new Error(`${_trn_type} requires positive qty`);
        if (ISSUE_TYPES.includes(_trn_type) && qty >= 0)   throw new Error(`${_trn_type} requires negative qty`);
        if (qty > 0 && unit_cost == null) throw new Error('unit_cost is required for receiving transactions');

        const exec = client ? (q, p) => client.query(q, p) : (q, p) => db.query(q, p);

        return exec(
            `INSERT INTO inventory_transactions (
                _trn_dt, _trn_type, _variant_no, _warehouse_no, qty,
                entered_qty, entered_uom, unit_cost, unit_price, reason_code,
                _lnk_table, _lnk_id, _ln_no, notes, _create_user_id
             ) VALUES (
                COALESCE($1, NOW()), $2, $3, $4, $5,
                $6, $7, $8, $9, $10,
                COALESCE($11, 'manual'), COALESCE($12, 0), COALESCE($13, 1), $14, $15
             ) RETURNING trn_no, unit_cost`,
            [
                _trn_dt ? new Date(_trn_dt) : null, _trn_type, _variant_no, _warehouse_no, qty,
                entered_qty ?? null, entered_uom ?? null, unit_cost ?? null, unit_price ?? null, reason_code ?? null,
                _lnk_table ?? null, _lnk_id ?? null, _ln_no ?? null, notes ?? null, userId
            ]
        ).then(res => res.rows[0]);
    }

    /**
     * Ledger history for a variant, newest first. Always paginated — the
     * ledger is unbounded.
     */
    function findForVariant(variantNo, { warehouseNo = null, limit = 50, offset = 0 } = {}) {
        const params  = [variantNo];
        let whClause  = '';
        if (warehouseNo != null) {
            params.push(warehouseNo);
            whClause = `AND _warehouse_no = $${params.length}`;
        }
        params.push(offset, limit);
        return db.query(
            `SELECT trn_no, _trn_dt, _trn_type, _warehouse_no, qty, entered_qty, entered_uom,
                    unit_cost, unit_price, reason_code, _lnk_table, _lnk_id, _ln_no, notes, _create_ts
             FROM inventory_transactions
             WHERE _variant_no = $1 ${whClause}
             ORDER BY _trn_dt DESC, trn_no DESC
             OFFSET $${params.length - 1} LIMIT $${params.length}`,
            params
        ).then(res => res.rows);
    }

    /**
     * All ledger rows linked to a document (order, PO, stock transfer, RMA).
     */
    function findForLink(lnkTable, lnkId) {
        return db.query(
            `SELECT t.trn_no, t._trn_dt, t._trn_type, t._variant_no, t._warehouse_no, t._ln_no,
                    t.qty, t.entered_qty, t.entered_uom, t.unit_cost, t.unit_price, t.reason_code,
                    v.sku, p.name AS product_name
             FROM inventory_transactions t
             JOIN product_variants v ON v.variant_no = t._variant_no
             JOIN products p         ON p.product_no = v._product_no
             WHERE t._lnk_table = $1 AND t._lnk_id = $2
             ORDER BY t._ln_no, t.trn_no`,
            [lnkTable, lnkId]
        ).then(res => res.rows);
    }

}());

module.exports = InventoryTransactions;
