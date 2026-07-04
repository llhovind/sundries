'use strict';

const { DB: db } = require('../common/db');

/**
 * Repository for shopping carts (new-world: variant-based, self-serve
 * checkout). The old quote/reconciliation workflow is gone — a cart's only
 * exits are checkout (status 'converted', handled by Orders.convertCart) or
 * abandonment.
 */
const Carts = (function () {

    return { findOpenCart, getOrCreate, upsertItem, removeItem };

    /**
     * The user's open cart with line items joined to live catalog data.
     * unit_price on a line is the add-time snapshot; `current_price` is
     * live so the UI can flag price changes before checkout.
     */
    function findOpenCart(userId) {
        return db.query(
            `SELECT c.cart_no, c.status, c._create_ts,
                    COALESCE(
                        JSON_AGG(
                            JSON_BUILD_OBJECT(
                                'id',            ci.id,
                                'variant_no',    ci._variant_no,
                                'name',          p.name,
                                'sku',           v.sku,
                                'qty',           ci.qty,
                                'unit_price',    COALESCE(ci.unit_price, v.price),
                                'current_price', v.price,
                                'base_uom',      p.base_uom,
                                'sell_method',   p.sell_method,
                                'min_cut_qty',   p.min_cut_qty,
                                'primary_image', COALESCE(v.primary_image, p.primary_image)
                            )
                            ORDER BY ci._create_ts
                        ) FILTER (WHERE ci.id IS NOT NULL),
                        '[]'
                    ) AS items
             FROM carts c
             LEFT JOIN cart_items ci      ON ci._cart_no = c.cart_no
             LEFT JOIN product_variants v ON v.variant_no = ci._variant_no
             LEFT JOIN products p         ON p.product_no = v._product_no
             WHERE c._user_id = $1 AND c.status = 'open'
             GROUP BY c.cart_no`,
            [userId]
        ).then(res => res.rows[0] || null);
    }

    /**
     * Returns the user's open cart, creating one if none exists. The partial
     * unique index (one open cart per user) makes this race-safe.
     */
    function getOrCreate(userId) {
        return db.query(
            `INSERT INTO carts (_user_id, status) VALUES ($1, 'open')
             ON CONFLICT DO NOTHING`,
            [userId]
        ).then(() => findOpenCart(userId));
    }

    /**
     * Adds a variant to the cart or updates its quantity. unit_price is
     * snapshotted from the live variant price at add time.
     */
    function upsertItem(cartNo, variantNo, qty) {
        return db.query(
            `INSERT INTO cart_items (_cart_no, _variant_no, qty, unit_price)
             SELECT $1, v.variant_no, $3, v.price
             FROM product_variants v
             JOIN products p ON p.product_no = v._product_no
             WHERE v.variant_no = $2 AND v.status = 'active' AND p.status = 'active'
             ON CONFLICT (_cart_no, _variant_no) DO UPDATE
                SET qty = EXCLUDED.qty, _modify_ts = NOW()
             RETURNING id`,
            [cartNo, variantNo, qty]
        ).then(res => res.rows[0] || null);   // null → variant unknown/inactive
    }

    function removeItem(cartNo, variantNo) {
        return db.query(
            `DELETE FROM cart_items WHERE _cart_no = $1 AND _variant_no = $2`,
            [cartNo, variantNo]
        );
    }

}());

module.exports = Carts;
