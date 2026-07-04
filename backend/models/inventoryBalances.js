'use strict';

const { DB: db } = require('../common/db');

/**
 * Read-side repository for inventory balances (derived state, maintained by
 * DB triggers — this module never writes balances directly).
 */
const InventoryBalances = (function () {

    return { findForVariant, availability, findLowStock };

    /**
     * Per-warehouse balances for one variant, including in-transit stock
     * (transport warehouses), ordered by warehouse priority.
     */
    function findForVariant(variantNo) {
        return db.query(
            `SELECT b._warehouse_no, w.code AS warehouse_code, w.name AS warehouse_name, w.wh_type,
                    b.qty_on_hand, b.qty_reserved,
                    b.qty_on_hand - b.qty_reserved AS qty_available,
                    b._modify_ts
             FROM inventory_balances b
             JOIN warehouses w ON w.warehouse_no = b._warehouse_no
             WHERE b._variant_no = $1
             ORDER BY w.priority, w.warehouse_no`,
            [variantNo]
        ).then(res => res.rows);
    }

    /**
     * Total sellable availability for a set of variants: on_hand - reserved
     * summed over active standard warehouses (transport stock is not sellable).
     *
     * @param {number[]} variantNos
     * @returns {Promise<Map<number, number>>} variant_no → qty_available
     */
    function availability(variantNos) {
        if (!variantNos.length) return Promise.resolve(new Map());
        return db.query(
            `SELECT b._variant_no,
                    SUM(b.qty_on_hand - b.qty_reserved) AS qty_available
             FROM inventory_balances b
             JOIN warehouses w ON w.warehouse_no = b._warehouse_no
             WHERE b._variant_no = ANY($1)
               AND w.wh_type = 'standard' AND w.status = 'active'
             GROUP BY b._variant_no`,
            [variantNos]
        ).then(res => new Map(res.rows.map(r => [Number(r._variant_no), Number(r.qty_available)])));
    }

    /**
     * Variants whose total available stock is at or below a threshold —
     * feeds the reorder/notification reports.
     */
    function findLowStock({ threshold = 0, limit = 50, offset = 0 } = {}) {
        return db.query(
            `SELECT v.variant_no, v.sku, p.name AS product_name,
                    SUM(b.qty_on_hand)                  AS qty_on_hand,
                    SUM(b.qty_reserved)                 AS qty_reserved,
                    SUM(b.qty_on_hand - b.qty_reserved) AS qty_available
             FROM inventory_balances b
             JOIN warehouses w        ON w.warehouse_no = b._warehouse_no AND w.wh_type = 'standard'
             JOIN product_variants v  ON v.variant_no = b._variant_no
             JOIN products p          ON p.product_no = v._product_no
             WHERE v.status = 'active'
             GROUP BY v.variant_no, v.sku, p.name
             HAVING SUM(b.qty_on_hand - b.qty_reserved) <= $1
             ORDER BY qty_available, v.sku
             OFFSET $2 LIMIT $3`,
            [threshold, offset, limit]
        ).then(res => res.rows);
    }

}());

module.exports = InventoryBalances;
