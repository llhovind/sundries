'use strict';

const { DB: db, withTransaction } = require('../common/db');
const Settings         = require('../common/settings');
const Orders           = require('../models/orders');
const Customers        = require('../models/customers');
const InventoryService = require('./inventoryService');
const PaymentsService  = require('./paymentsService');
const PromotionService = require('./promotionService');
const ShippingService  = require('./shippingService');
const TaxService       = require('./taxService');

function log(level, msg, extra = {}) {
    process.stdout.write(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }) + '\n');
}

/**
 * CheckoutService — "Place Order" orchestration.
 *
 * Sequence (per the agreed workflow):
 *   1. Resolve items (open cart for members; inline items for guests) and
 *      apply the customer's per-line backorder choices.
 *   2. Validate (active variants, min-cut for measured goods).
 *   3. Price: subtotal → shipping rules → tax → total.
 *   4. ONE transaction: order + lines + stock reservations (15-min TTL).
 *      A reservation failure rolls everything back and surfaces per-line
 *      availability so the UI reverts one step.
 *   5. After commit: create the payment intent (external call — never inside
 *      the DB transaction). If that fails, compensate: release + cancel.
 *
 * Payment confirmation then arrives via webhook (see PaymentsService).
 */
const CheckoutService = (function () {

    const BACKORDER_ACTIONS = ['reserve', 'backorder', 'remove', 'notify'];

    return { placeFromCart, placeGuest };

    /**
     * Authenticated checkout from the user's open cart.
     *
     * @param {number} userId
     * @param {object} opts - { shipTo, backorders?, notes?, provider? }
     */
    async function placeFromCart(userId, opts = {}) {
        const items = await Orders.getOpenCartForCheckout(userId);
        if (!items.length) {
            throw Object.assign(new Error('No open cart with items to check out'), { status: 400 });
        }

        const custRes = await db.query(
            `SELECT c.id AS customer_id, u.email
             FROM users u LEFT JOIN customers c ON c.user_id = u.id
             WHERE u.id = $1`,
            [userId]
        );
        const who = custRes.rows[0];
        if (!who || !who.customer_id) {
            throw Object.assign(
                new Error('Complete your customer profile before checking out'), { status: 422 });
        }

        return place({
            customerId: who.customer_id,
            email: who.email,
            actorUserId: userId,
            cartNo: items[0].cart_no,
            items,
            ...opts,
        });
    }

    /**
     * Guest checkout: implicit account + inline items.
     *
     * @param {object} data - { email, name, shipTo, items:[{variant_no, qty}],
     *                          backorders?, notes?, provider? }
     */
    async function placeGuest(data) {
        const { email, name, items = [], shipTo = {}, backorders, notes, provider, promoCode } = data;
        if (!email) throw Object.assign(new Error('email is required'), { status: 400 });
        if (!name)  throw Object.assign(new Error('name is required'), { status: 400 });
        if (!items.length) throw Object.assign(new Error('items are required'), { status: 400 });

        // Inline items may repeat a variant (client bugs, hand-built requests);
        // orders key lines by variant, so merge duplicates by summing qty.
        const mergedItems = [...items.reduce((m, i) => {
            const key = Number(i.variant_no);
            m.set(key, { variant_no: key, qty: Number(i.qty) + (m.get(key)?.qty || 0) });
            return m;
        }, new Map()).values()];

        const account = await Customers.ensureGuestAccount({ email, name, ...shipTo });
        const resolved = await Orders.resolveCheckoutItems(mergedItems);

        return place({
            customerId: account.customerId,
            email,
            actorUserId: account.userId,
            cartNo: null,
            items: resolved,
            shipTo: { name, ...shipTo },
            backorders, notes, provider, promoCode,
        });
    }

    // ── Core ────────────────────────────────────────────────────────────────

    async function place({ customerId, email, actorUserId, cartNo, items,
                           shipTo = {}, backorders = {}, notes = null, provider = null,
                           promoCode = null }) {

        // 1. Apply per-line backorder choices
        const lines = [];
        for (const item of items) {
            const action = backorders[item.variant_no] || backorders[String(item.variant_no)] || 'reserve';
            if (!BACKORDER_ACTIONS.includes(action)) {
                throw Object.assign(new Error(`Invalid backorder action '${action}'`), { status: 400 });
            }
            if (action === 'remove') continue;
            if (action === 'notify') {
                await db.query(
                    `INSERT INTO stock_notifications (_variant_no, email, _customer_id)
                     VALUES ($1, $2, $3)`,
                    [item.variant_no, email, customerId]
                );
                continue;
            }
            lines.push({ ...item, action });
        }
        if (!lines.length) {
            throw Object.assign(new Error('No purchasable items remain in the order'), { status: 400 });
        }

        // 2. Validate
        for (const ln of lines) {
            if (ln.variant_status !== 'active') {
                throw Object.assign(new Error(`'${ln.name}' is no longer available`), { status: 409 });
            }
            if (!(ln.qty > 0)) {
                throw Object.assign(new Error(`Invalid quantity for '${ln.name}'`), { status: 400 });
            }
            if (ln.sell_method === 'measure' && ln.min_cut_qty != null && Number(ln.qty) < Number(ln.min_cut_qty)) {
                throw Object.assign(
                    new Error(`'${ln.name}' has a minimum cut of ${ln.min_cut_qty} ${ln.base_uom}`),
                    { status: 400 });
            }
        }

        // 3. Price
        const round2   = n => Number(n.toFixed(2));
        let subtotal   = 0;
        for (const ln of lines) {
            ln.line_total = round2(Number(ln.qty) * Number(ln.unit_price));
            subtotal += ln.line_total;
        }
        subtotal = round2(subtotal);

        // Promotion (optional, single code). free_shipping waives the base
        // rate only — heavy-item freight surcharges are real costs and stay.
        let promo = null;
        if (promoCode) {
            promo = await PromotionService.validate(promoCode, { subtotal });
        }
        const discount = promo ? promo.discount : 0;

        const shipping = await ShippingService.calculate(subtotal, lines);
        if (promo && promo.free_shipping) shipping.total = shipping.surcharge;

        const taxable  = round2(subtotal - discount);
        const taxInfo  = await TaxService.calculate(taxable, shipTo);
        const total    = round2(taxable + shipping.total + taxInfo.tax);

        const currency = await Settings.getString('store.currency', 'USD');

        // 4. Order + reservations, atomically
        const { ord_no } = await withTransaction(async (client) => {
            const created = await Orders.create({
                customerId, email, currency,
                subtotal, discountAmt: discount, tax: taxInfo.tax, shipping: shipping.total, total,
                cartNo, shipTo, notes,
                lines: lines.map(ln => ({
                    ...ln,
                    fulfillment_status: ln.action === 'backorder' ? 'backordered' : 'pending',
                })),
            }, actorUserId, client);

            const toReserve = lines
                .filter(ln => ln.action !== 'backorder')
                .map(ln => ({
                    orderLineId: created.lineIds.get(Number(ln.variant_no)),
                    variantNo: ln.variant_no,
                    qty: Number(ln.qty),
                }));

            if (toReserve.length) {
                // Throws ReservationError (409 + per-line availability) → full rollback
                await InventoryService.reserveForOrder(created.ord_no, toReserve, actorUserId, undefined, client);
            }
            // Atomic redemption claim — an exhausted code rolls the order back.
            if (promo) {
                await PromotionService.redeem(client, promo.promo_no, created.ord_no, customerId, discount);
            }

            if (cartNo) await Orders.convertCart(cartNo, created.ord_no, client);
            return created;
        });

        // 5. Payment intent — outside the DB transaction, with compensation
        let payment;
        try {
            payment = await PaymentsService.createPaymentForOrder({ ord_no, total, currency }, provider);
        } catch (err) {
            log('error', 'payment intent creation failed; compensating order', { ord_no, error: err.message });
            await InventoryService.releaseOrderReservations(ord_no)
                .catch(e => log('error', 'compensation release failed', { ord_no, error: e.message }));
            await Orders.setStatus(ord_no, 'payment_failed', ['pending_payment'], actorUserId)
                .catch(e => log('error', 'compensation status failed', { ord_no, error: e.message }));
            throw Object.assign(new Error('Could not initialize payment — order was not placed'), { status: 502 });
        }

        // Fraud screening runs async post-placement — it flags for review,
        // never blocks a sale, and its latency never touches checkout.
        const Jobs = require('./jobs');
        Jobs.send(Jobs.QUEUES.ORDER_SCREEN, { ord_no })
            .catch(err => log('warn', 'fraud screen enqueue failed', { ord_no, error: err.message }));

        return {
            ord_no,
            status: 'pending_payment',
            subtotal, discount, shipping: shipping.total, tax: taxInfo.tax, total, currency,
            promo: promo ? promo.code : null,
            backordered: lines.filter(l => l.action === 'backorder').map(l => Number(l.variant_no)),
            payment,
        };
    }

}());

module.exports = CheckoutService;
