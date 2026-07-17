'use strict';

const { DB: db } = require('../../common/db');

/**
 * Current inventory valuation from remaining FIFO layers, per warehouse.
 * Transport warehouses appear with in_transit = true — goods on trucks are
 * still on the books.
 */
module.exports = {
    slug:     'valuation',
    name:     'Inventory valuation',
    descr:    'On-hand value from remaining FIFO cost layers, per warehouse',
    category: 'finance',
    mode:     'immediate',
    params: [
        { name: 'warehouse_no', label: 'Warehouse #', type: 'number' },
    ],
    columns: [
        { key: 'warehouse_code', label: 'Code',         format: 'text' },
        { key: 'warehouse_name', label: 'Warehouse',    format: 'text' },
        { key: 'in_transit',     label: 'In transit',   format: 'bool' },
        { key: 'variants',       label: 'Variants',     format: 'int' },
        { key: 'units_on_hand',  label: 'Units',        format: 'qty' },
        { key: 'value',          label: 'Value (FIFO)', format: 'money' },
    ],

    run({ warehouse_no }) {
        const params = [];
        let whClause = '';
        if (warehouse_no != null) {
            params.push(warehouse_no);
            whClause = `AND l._warehouse_no = $1`;
        }
        return db.query(
            `SELECT w.warehouse_no, w.code AS warehouse_code, w.name AS warehouse_name,
                    (w.wh_type = 'transport')            AS in_transit,
                    COUNT(DISTINCT l._variant_no)::int   AS variants,
                    SUM(l.qty_remaining)                 AS units_on_hand,
                    ROUND(SUM(l.qty_remaining * l.unit_cost), 2) AS value
             FROM inventory_cost_layers l
             JOIN warehouses w ON w.warehouse_no = l._warehouse_no
             WHERE l.qty_remaining > 0 ${whClause}
             GROUP BY w.warehouse_no
             ORDER BY w.priority, w.warehouse_no`,
            params
        ).then(res => res.rows);
    },
};
