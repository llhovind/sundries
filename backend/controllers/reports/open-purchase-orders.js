'use strict';

const { DB: db } = require('../../common/db');

/**
 * Purchase orders by status with receiving progress and committed spend —
 * what is on order, from whom, and how much of it has landed.
 */

const STATUSES = ['open', 'received', 'closed', 'cancelled'];

module.exports = {
    slug:     'open-purchase-orders',
    name:     'Purchase orders',
    descr:    'POs by status: vendor, receiving progress, committed spend',
    category: 'purchasing',
    mode:     'immediate',
    params: [
        { name: 'status', label: 'Status', type: 'select', options: STATUSES, default: 'open' },
    ],
    columns: [
        { key: 'po_no',          label: 'PO',             format: 'int' },
        { key: 'vendor_name',    label: 'Vendor',         format: 'text' },
        { key: 'warehouse_code', label: 'Deliver to',     format: 'text' },
        { key: 'po_dt',          label: 'Ordered',        format: 'date' },
        { key: 'lines',          label: 'Lines',          format: 'int' },
        { key: 'units_ordered',  label: 'Units ordered',  format: 'qty' },
        { key: 'units_received', label: 'Units received', format: 'qty' },
        { key: 'value',          label: 'Value',          format: 'money' },
    ],

    run({ status }) {
        return db.query(
            `SELECT po.po_no, ve.name AS vendor_name, w.code AS warehouse_code,
                    po.po_dt, po.po_status,
                    COUNT(l.id)::int                          AS lines,
                    COALESCE(SUM(l.qty_ordered), 0)           AS units_ordered,
                    COALESCE(SUM(l.qty_received), 0)          AS units_received,
                    ROUND(COALESCE(SUM(l.qty_ordered * l.unit_cost), 0), 2) AS value
             FROM purchaseorders po
             JOIN vendors ve    ON ve.id = po._vendor_id
             JOIN warehouses w  ON w.warehouse_no = po._warehouse_no
             LEFT JOIN purchaseorder_lines l ON l._po_no = po.po_no
             WHERE po.po_status = $1
             GROUP BY po.po_no, ve.name, w.code
             ORDER BY po.po_dt DESC`,
            [status]
        ).then(res => res.rows);
    },
};
