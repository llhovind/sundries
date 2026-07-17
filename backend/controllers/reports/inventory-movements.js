'use strict';

const { DB: db } = require('../../common/db');
const { isoToday, isoDaysAgo } = require('../../services/reporting/dates');

/**
 * Full ledger export over a period — every IN/OUT/ADJ row with product and
 * warehouse context. Unbounded by row count (a busy store's ledger runs to
 * millions of rows), so it is a stored report: generation happens in a
 * spawned subprocess, the requester is notified when the snapshot is ready,
 * and the result is reviewed or downloaded from the saved-runs list.
 */
module.exports = {
    slug:     'inventory-movements',
    name:     'Inventory movements',
    descr:    'Full stock ledger export for a period (generated in the background)',
    category: 'inventory',
    mode:     'stored',
    params: [
        { name: 'from', label: 'From', type: 'date', default: () => isoDaysAgo(30) },
        { name: 'to',   label: 'To',   type: 'date', default: isoToday },
    ],
    columns: [
        { key: 'trn_dt',         label: 'Date',      format: 'datetime' },
        { key: 'trn_type',       label: 'Type',      format: 'text' },
        { key: 'sku',            label: 'SKU',       format: 'text' },
        { key: 'product_name',   label: 'Product',   format: 'text' },
        { key: 'warehouse_code', label: 'Warehouse', format: 'text' },
        { key: 'qty',            label: 'Qty',       format: 'qty' },
        { key: 'unit_cost',      label: 'Unit cost', format: 'money' },
        { key: 'reason_code',    label: 'Reason',    format: 'text' },
        { key: 'source',         label: 'Source',    format: 'text' },
    ],

    run({ from, to }) {
        return db.query(
            `SELECT t._trn_dt AS trn_dt, t._trn_type AS trn_type,
                    v.sku, p.name AS product_name, w.code AS warehouse_code,
                    t.qty, t.unit_cost, t.reason_code,
                    CASE WHEN t._lnk_table IS NULL THEN NULL
                         ELSE t._lnk_table || ' #' || t._lnk_id END AS source
             FROM inventory_transactions t
             JOIN product_variants v ON v.variant_no = t._variant_no
             JOIN products p         ON p.product_no = v._product_no
             JOIN warehouses w       ON w.warehouse_no = t._warehouse_no
             WHERE t._trn_dt >= $1::date AND t._trn_dt < $2::date + 1
             ORDER BY t._trn_dt, t.trn_no`,
            [from, to]
        ).then(res => res.rows);
    },
};
