'use strict';

const InventoryBalances = require('../../models/inventoryBalances');

// Reports return full result sets (paging is a UI concern); the cap only
// bounds a pathological catalog-wide threshold.
const MAX_ROWS = 5000;

/**
 * Active variants whose available stock (on hand minus reserved, across
 * active standard warehouses) is at or below the threshold — the reorder
 * worklist for Purchasing. Backed by InventoryBalances.findLowStock.
 */
module.exports = {
    slug:     'low-stock',
    name:     'Low stock',
    descr:    'Active variants at or below an available-stock threshold — reorder candidates',
    category: 'inventory',
    mode:     'immediate',
    params: [
        { name: 'threshold', label: 'Available ≤', type: 'number' },
    ],
    columns: [
        { key: 'sku',           label: 'SKU',       format: 'text' },
        { key: 'product_name',  label: 'Product',   format: 'text' },
        { key: 'qty_on_hand',   label: 'On hand',   format: 'qty' },
        { key: 'qty_reserved',  label: 'Reserved',  format: 'qty' },
        { key: 'qty_available', label: 'Available', format: 'qty' },
    ],

    run({ threshold }) {
        return InventoryBalances.findLowStock({
            threshold: threshold ?? 0,
            limit: MAX_ROWS,
            offset: 0,
        });
    },
};
