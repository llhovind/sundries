'use strict';

const { DB: db } = require('../common/db');
const Shipments  = require('./shipments');

/**
 * Repository for the orders aggregate (orders + order_lines) and the
 * cart-for-checkout read. All quantities are in the product's base UOM;
 * order lines snapshot sku/description/price so later catalog edits never
 * rewrite history.
 */
const Orders = (function () {

    return {
        getOpenCartForCheckout,
        resolveCheckoutItems,
        create,
        findOne,
        list,
        setStatus,
        markLinesShipped,
        convertCart,
    };

    /**
     * The user's open cart joined to live variant/product data — price
     * fallback, weight for shipping, and min-cut validation inputs.
     */
    function getOpenCartForCheckout(userId) {
        return db.query(
            `SELECT c.cart_no,
                    ci._variant_no                           AS variant_no,
                    ci.qty, ci.entered_qty, ci.entered_uom,
                    COALESCE(ci.unit_price, v.price)         AS unit_price,
                    v.sku, v.status                          AS variant_status,
                    COALESCE(v.weight_lbs, p.weight_lbs)     AS weight_lbs,
                    p.name, p.sell_method, p.min_cut_qty, p.base_uom
             FROM carts c
             JOIN cart_items ci      ON ci._cart_no = c.cart_no
             JOIN product_variants v ON v.variant_no = ci._variant_no
             JOIN products p         ON p.product_no = v._product_no
             WHERE c._user_id = $1 AND c.status = 'open'
             ORDER BY ci._create_ts`,
            [userId]
        ).then(res => res.rows);
    }

    /**
     * Guest checkout sends inline items instead of a stored cart — resolve
     * them against the catalog with the same shape as the cart read.
     *
     * @param {Array<{variant_no:number, qty:number}>} items
     */
    function resolveCheckoutItems(items) {
        return db.query(
            `SELECT v.variant_no, v.sku, v.price AS unit_price, v.status AS variant_status,
                    COALESCE(v.weight_lbs, p.weight_lbs) AS weight_lbs,
                    p.name, p.sell_method, p.min_cut_qty, p.base_uom
             FROM product_variants v
             JOIN products p ON p.product_no = v._product_no
             WHERE v.variant_no = ANY($1)`,
            [items.map(i => i.variant_no)]
        ).then(res => {
            const byVariant = new Map(res.rows.map(r => [Number(r.variant_no), r]));
            return items.map(i => {
                const v = byVariant.get(Number(i.variant_no));
                if (!v) throw Object.assign(new Error(`Unknown variant ${i.variant_no}`), { status: 400 });
                return { ...v, qty: i.qty, entered_qty: null, entered_uom: null, cart_no: null };
            });
        });
    }

    /**
     * Inserts the order header + lines. Caller manages the transaction.
     *
     * @param {object} data   - header fields + lines[]
     * @param {number} userId
     * @param {object} client - pg transaction client (required)
     * @returns {Promise<{ord_no:number, lineIds:Map<number,number>}>} variant_no → order_lines.id
     */
    async function create(data, userId, client) {
        const {
            customerId, email, currency, subtotal, discountAmt = 0, tax, shipping, total,
            cartNo = null, shipTo = {}, notes = null, lines,
        } = data;

        const res = await client.query(
            `INSERT INTO orders (
                _customer_id, email, currency, subtotal, discount_amt, tax, shipping, total,
                status, _cart_no,
                ship_name, ship_address, ship_city, ship_state, ship_zip, ship_country, ship_phone,
                notes, _create_user_id, _modify_user_id
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_payment',$9,
                       $10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
             RETURNING ord_no`,
            [customerId, email, currency, subtotal, discountAmt, tax, shipping, total, cartNo,
             shipTo.name || null, shipTo.address || null, shipTo.city || null, shipTo.state || null,
             shipTo.zip || null, shipTo.country || null, shipTo.phone || null,
             notes, userId]
        );
        const ordNo = res.rows[0].ord_no;

        const lineIds = new Map();
        for (let i = 0; i < lines.length; i++) {
            const ln = lines[i];
            const lr = await client.query(
                `INSERT INTO order_lines
                    (_ord_no, ln_no, _variant_no, sku, descr, qty, entered_qty, entered_uom,
                     unit_price, line_total, fulfillment_status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                 RETURNING id`,
                [ordNo, i + 1, ln.variant_no, ln.sku, ln.name, ln.qty,
                 ln.entered_qty ?? null, ln.entered_uom ?? null,
                 ln.unit_price, ln.line_total, ln.fulfillment_status || 'pending']
            );
            lineIds.set(Number(ln.variant_no), lr.rows[0].id);
        }
        return { ord_no: ordNo, lineIds };
    }

    /**
     * Full order with lines and payments. Customers see only their own
     * orders (scoped via customers.user_id); staff callers pass staff=true.
     */
    function findOne(ordNo, { userId = null, staff = false } = {}) {
        const ownerClause = staff ? '' : 'AND c.user_id = $2';
        const params      = staff ? [ordNo] : [ordNo, userId];

        return Promise.all([
            db.query(
                `SELECT o.*, c.name AS customer_name
                 FROM orders o
                 JOIN customers c ON c.id = o._customer_id
                 WHERE o.ord_no = $1 ${ownerClause}`,
                params
            ).then(res => res.rows[0] || null),
            db.query(
                `SELECT id, ln_no, _variant_no, sku, descr, qty, entered_qty, entered_uom,
                        unit_price, line_total, fulfillment_status, _warehouse_no
                 FROM order_lines WHERE _ord_no = $1 ORDER BY ln_no`,
                [ordNo]
            ).then(res => res.rows),
            db.query(
                `SELECT payment_no, provider, intent_ref, amount, currency, status, _create_ts
                 FROM payments WHERE _ord_no = $1 ORDER BY payment_no`,
                [ordNo]
            ).then(res => res.rows),
            Shipments.findByOrder(ordNo),
        ]).then(([order, lines, payments, shipments]) => {
            if (!order) return null;
            return { ...order, lines, payments, shipments };
        });
    }

    function list({ userId = null, staff = false, status = null, limit = 25, offset = 0 } = {}) {
        const params  = [];
        const clauses = [];
        if (!staff) {
            params.push(userId);
            clauses.push(`c.user_id = $${params.length}`);
        }
        if (status) {
            params.push(status);
            clauses.push(`o.status = $${params.length}`);
        }
        const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
        params.push(offset, limit);

        return db.query(
            `SELECT o.ord_no, o.status, o.email, o.currency, o.total, o.placed_at,
                    c.name AS customer_name,
                    COUNT(ol.id)::int AS line_count,
                    COUNT(*) OVER()::int AS _total
             FROM orders o
             JOIN customers c    ON c.id = o._customer_id
             LEFT JOIN order_lines ol ON ol._ord_no = o.ord_no
             ${where}
             GROUP BY o.ord_no, c.name
             ORDER BY o.placed_at DESC
             OFFSET $${params.length - 1} LIMIT $${params.length}`,
            params
        ).then(res => {
            const total = res.rows.length ? res.rows[0]._total : 0;
            return { rows: res.rows.map(({ _total, ...r }) => r), total };
        });
    }

    /**
     * Guarded status transition — only fires when the order is currently in
     * one of fromStatuses, so replayed webhooks and double-clicks are no-ops.
     * The order_status_history trigger records the change.
     */
    function setStatus(ordNo, toStatus, fromStatuses, userId, client) {
        const exec = client ? (q, p) => client.query(q, p) : (q, p) => db.query(q, p);
        return exec(
            `UPDATE orders
             SET status = $2, _modify_ts = NOW(), _modify_user_id = $3
             WHERE ord_no = $1 AND status = ANY($4)
             RETURNING ord_no, status`,
            [ordNo, toStatus, userId, fromStatuses]
        ).then(res => res.rows[0] || null);
    }

    /** @returns {Promise<Array<{id:number, qty:number}>>} the lines that shipped */
    function markLinesShipped(ordNo, client) {
        const exec = client ? (q, p) => client.query(q, p) : (q, p) => db.query(q, p);
        return exec(
            `UPDATE order_lines SET fulfillment_status = 'shipped'
             WHERE _ord_no = $1 AND fulfillment_status = 'reserved'
             RETURNING id, qty`,
            [ordNo]
        ).then(res => res.rows);
    }

    /** Links the cart to its order and closes it. */
    function convertCart(cartNo, ordNo, client) {
        return client.query(
            `UPDATE carts SET status = 'converted', _ord_no = $2, _modify_ts = NOW()
             WHERE cart_no = $1 AND status = 'open'`,
            [cartNo, ordNo]
        );
    }

}());

module.exports = Orders;
