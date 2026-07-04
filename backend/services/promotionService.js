'use strict';

const { DB: db } = require('../common/db');

/**
 * PromotionService — v1 promotion engine.
 *
 * Supported: single code per order, three types (percent / fixed_amount /
 * free_shipping), active window, global max_redemptions with an atomic
 * claim so a code can never be over-redeemed under concurrency.
 *
 * Deliberately NOT yet supported (extend here when needed): code stacking,
 * per-customer limits, product/category-scoped rules, auto-applied promos.
 */
const PromotionService = (function () {

    return { create, update, list, validate, redeem };

    // ── Admin CRUD (promotions:manage) ─────────────────────────────────────

    function create(data, userId) {
        const { code, name, promo_type, value = 0, starts_at, ends_at, max_redemptions, status = 'draft' } = data;
        if (!code || !name)  throw Object.assign(new Error('code and name are required'), { status: 400 });
        if (!['percent', 'fixed_amount', 'free_shipping'].includes(promo_type)) {
            throw Object.assign(new Error('promo_type must be percent, fixed_amount or free_shipping'), { status: 400 });
        }
        if (promo_type === 'percent' && !(value > 0 && value <= 100)) {
            throw Object.assign(new Error('percent value must be between 0 and 100'), { status: 400 });
        }
        if (promo_type === 'fixed_amount' && !(value > 0)) {
            throw Object.assign(new Error('fixed_amount value must be positive'), { status: 400 });
        }
        return db.query(
            `INSERT INTO promotions (code, name, promo_type, value, starts_at, ends_at,
                                     max_redemptions, status, _create_user_id, _modify_user_id)
             VALUES (UPPER($1),$2,$3,$4,$5,$6,$7,$8,$9,$9)
             RETURNING promo_no, code`,
            [code, name, promo_type, value, starts_at || null, ends_at || null,
             max_redemptions ?? null, status, userId]
        ).then(res => res.rows[0])
         .catch(err => {
             if (err.code === '23505') {
                 throw Object.assign(new Error('Promotion code already exists'), { status: 409 });
             }
             throw err;
         });
    }

    function update(promoNo, data, userId) {
        const cols = ['name', 'value', 'starts_at', 'ends_at', 'max_redemptions', 'status']
            .filter(c => data[c] !== undefined);
        if (!cols.length) throw Object.assign(new Error('Nothing to update'), { status: 400 });
        const sets = cols.map((c, i) => `${c} = $${i + 1}`);
        const vals = cols.map(c => data[c]);
        vals.push(userId, promoNo);
        return db.query(
            `UPDATE promotions SET ${sets.join(', ')}, _modify_ts = NOW(), _modify_user_id = $${vals.length - 1}
             WHERE promo_no = $${vals.length}
             RETURNING promo_no, code, status`,
            vals
        ).then(res => res.rows[0] || null);
    }

    function list({ status = null, limit = 50, offset = 0 } = {}) {
        const params = [];
        let where = '';
        if (status) { params.push(status); where = `WHERE status = $1`; }
        params.push(offset, limit);
        return db.query(
            `SELECT promo_no, code, name, promo_type, value, starts_at, ends_at,
                    max_redemptions, redemption_count, status, _create_ts,
                    COUNT(*) OVER()::int AS _total
             FROM promotions ${where}
             ORDER BY _create_ts DESC
             OFFSET $${params.length - 1} LIMIT $${params.length}`,
            params
        ).then(res => ({
            rows: res.rows.map(({ _total, ...r }) => r),
            total: res.rows.length ? res.rows[0]._total : 0,
        }));
    }

    // ── Checkout integration ────────────────────────────────────────────────

    /**
     * Validates a code against the current time/redemption budget and prices
     * the discount for a given subtotal. Throws 400 with a customer-safe
     * message on any failure.
     *
     * @returns {Promise<{promo_no:number, code:string, promo_type:string,
     *                    discount:number, free_shipping:boolean}>}
     */
    async function validate(code, { subtotal }) {
        const res = await db.query(
            `SELECT promo_no, code, promo_type, value, starts_at, ends_at,
                    max_redemptions, redemption_count, status
             FROM promotions WHERE code = UPPER($1)`,
            [code]
        );
        const promo = res.rows[0];
        const reject = msg => { throw Object.assign(new Error(msg), { status: 400 }); };

        if (!promo || promo.status !== 'active')                          reject('Invalid promotion code');
        if (promo.starts_at && new Date(promo.starts_at) > new Date())    reject('Promotion is not active yet');
        if (promo.ends_at && new Date(promo.ends_at) < new Date())        reject('Promotion has expired');
        if (promo.max_redemptions != null && promo.redemption_count >= promo.max_redemptions) {
            reject('Promotion has been fully redeemed');
        }

        let discount = 0;
        if (promo.promo_type === 'percent')      discount = Number((subtotal * Number(promo.value) / 100).toFixed(2));
        if (promo.promo_type === 'fixed_amount') discount = Math.min(Number(promo.value), subtotal);

        return {
            promo_no: Number(promo.promo_no),
            code: promo.code,
            promo_type: promo.promo_type,
            discount,
            free_shipping: promo.promo_type === 'free_shipping',
        };
    }

    /**
     * Claims one redemption inside the order transaction. The conditional
     * UPDATE is the concurrency guard: two orders racing for a code's last
     * redemption cannot both win. Throws 409 → the whole checkout rolls back.
     */
    async function redeem(client, promoNo, ordNo, customerId, amount) {
        const claimed = await client.query(
            `UPDATE promotions
             SET redemption_count = redemption_count + 1, _modify_ts = NOW()
             WHERE promo_no = $1 AND status = 'active'
               AND (max_redemptions IS NULL OR redemption_count < max_redemptions)
             RETURNING promo_no`,
            [promoNo]
        );
        if (!claimed.rows.length) {
            throw Object.assign(new Error('Promotion has been fully redeemed'), { status: 409 });
        }
        await client.query(
            `INSERT INTO promotion_redemptions (_promo_no, _ord_no, _customer_id, amount)
             VALUES ($1, $2, $3, $4)`,
            [promoNo, ordNo, customerId, amount]
        );
    }

}());

module.exports = PromotionService;
