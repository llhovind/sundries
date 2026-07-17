'use strict';

const { DB: db } = require('../../common/db');

/**
 * Active reservations — stock currently held by in-flight checkouts.
 */
module.exports = {
    slug:     'reservations',
    name:     'Active reservations',
    descr:    'Stock held by in-flight checkouts, oldest expiry first',
    category: 'inventory',
    mode:     'immediate',
    params:   [],
    columns: [
        { key: 'ord_no',         label: 'Order',     format: 'int' },
        { key: 'product_name',   label: 'Product',   format: 'text' },
        { key: 'sku',            label: 'SKU',       format: 'text' },
        { key: 'qty',            label: 'Qty',       format: 'qty' },
        { key: 'warehouse_code', label: 'Warehouse', format: 'text' },
        { key: 'expires_at',     label: 'Expires',   format: 'datetime' },
    ],

    run() {
        return db.query(
            `SELECT r.reservation_no, r._ord_no AS ord_no, r.qty, r.expires_at,
                    v.sku, p.name AS product_name, w.code AS warehouse_code
             FROM inventory_reservations r
             JOIN product_variants v ON v.variant_no = r._variant_no
             JOIN products p         ON p.product_no = v._product_no
             JOIN warehouses w       ON w.warehouse_no = r._warehouse_no
             WHERE r.status = 'active'
             ORDER BY r.expires_at`,
        ).then(res => res.rows);
    },
};
