'use strict';

/**
 * Checkout + payments integration tests, end to end through the fake Stripe
 * provider: place → reserve → (fake) webhook confirm → stock issued → ship
 * (capture-on-fulfillment) → refund. Runs against the real database and the
 * real Express app; only the payment provider is fake — by design, it drives
 * the exact same webhook pipeline as production Stripe.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
process.env.PAYMENT_PROVIDER = 'fake';

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');
const PaymentsService  = require('../services/paymentsService');
const fakeAdapter      = require('../services/payments/fakeStripeAdapter');

const RUN = Date.now();
let mainWh, productNo, heavyProductNo, measureProductNo;

function token(user, perms = [], roles = ['customer']) {
    return jwt.sign(
        { sub: user.id, email: user.email, role: user.role || 'customer', roles, perms },
        process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }
    );
}

async function makeVariant(tag, { price = 10, weight = null, product = productNo } = {}) {
    const res = await db.query(
        `INSERT INTO product_variants (_product_no, sku, price, weight_lbs)
         VALUES ($1, $2, $3, $4) RETURNING variant_no`,
        [product, `CHK-${RUN}-${tag}`, price, weight]
    );
    return Number(res.rows[0].variant_no);
}

async function receive(variantNo, qty, unitCost = 2) {
    await db.query(
        `INSERT INTO inventory_transactions (_trn_type, _variant_no, _warehouse_no, qty, unit_cost)
         VALUES ('IN', $1, $2, $3, $4)`,
        [variantNo, mainWh, qty, unitCost]
    );
}

/** Registered customer with profile + open cart containing the given items. */
async function makeShopper(tag, cartItems = []) {
    const u = await db.query(
        `INSERT INTO users (email, role, status) VALUES ($1, 'customer', 'active') RETURNING id, email, role`,
        [`chk-${tag}-${RUN}@example.com`]
    );
    const user = u.rows[0];
    await db.query(
        `INSERT INTO user_roles (user_id, role_no) SELECT $1, role_no FROM roles WHERE code = 'customer'`,
        [user.id]);
    await db.query(
        `INSERT INTO customers (user_id, name, email) VALUES ($1, $2, $3)`,
        [user.id, `Shopper ${tag}`, user.email]);

    if (cartItems.length) {
        const cart = await db.query(
            `INSERT INTO carts (_user_id, status) VALUES ($1, 'open') RETURNING cart_no`, [user.id]);
        for (const it of cartItems) {
            await db.query(
                `INSERT INTO cart_items (_cart_no, _variant_no, qty, unit_price)
                 VALUES ($1, $2, $3, $4)`,
                [cart.rows[0].cart_no, it.variantNo, it.qty, it.unitPrice ?? null]);
        }
    }
    return user;
}

const SHIP_TO = { name: 'Test Shopper', address: '1 Demo St', city: 'Springfield',
                  state: 'IL', zip: '62701', country: 'US' };

async function placeOrder(user, body = {}) {
    return request(app)
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${token(user)}`)
        .send({ shipTo: SHIP_TO, ...body });
}

async function fakeConfirm(intentRef, outcome = 'authorized') {
    return request(app)
        .post('/api/v1/payments/fake/confirm')
        .send({ intent_ref: intentRef, outcome });
}

async function orderRow(ordNo) {
    return db.query(`SELECT * FROM orders WHERE ord_no = $1`, [ordNo]).then(r => r.rows[0]);
}

beforeAll(async () => {
    mainWh = (await db.query(`SELECT warehouse_no FROM warehouses WHERE code = 'MAIN'`)).rows[0].warehouse_no;

    const mk = (name, extra = '') => db.query(
        `INSERT INTO products (name, status, sell_method, base_uom ${extra ? ', ' + extra.split('=')[0] : ''})
         VALUES ($1, 'active', $2, $3 ${extra ? ', ' + extra.split('=')[1] : ''})
         RETURNING product_no`,
        name);

    productNo = Number((await db.query(
        `INSERT INTO products (name, status) VALUES ($1, 'active') RETURNING product_no`,
        [`Checkout Widget ${RUN}`])).rows[0].product_no);
    heavyProductNo = Number((await db.query(
        `INSERT INTO products (name, status, weight_lbs) VALUES ($1, 'active', 55) RETURNING product_no`,
        [`Anvil ${RUN}`])).rows[0].product_no);
    measureProductNo = Number((await db.query(
        `INSERT INTO products (name, status, sell_method, base_uom, min_cut_qty)
         VALUES ($1, 'active', 'measure', 'ft', 2) RETURNING product_no`,
        [`Rope ${RUN}`])).rows[0].product_no);
});

afterAll(async () => {
    await pool.end();
});

describe('given an open cart when the customer places the order then it is priced, reserved and payable', () => {

    test('given subtotal under $50 then flat shipping applies and reservations hold the stock', async () => {
        const v = await makeVariant('BASIC', { price: 10 });
        await receive(v, 10);
        const user = await makeShopper('basic', [{ variantNo: v, qty: 3 }]);

        const res = await placeOrder(user);
        expect(res.status).toBe(201);

        const order = res.body.content.order;
        expect(order.subtotal).toBe(30);
        expect(order.shipping).toBe(9.95);
        expect(order.total).toBe(39.95);
        expect(order.payment.provider).toBe('fake');
        expect(order.payment.intent_ref).toMatch(/^fpi_/);
        expect(order.payment.client_secret).toBeTruthy();

        const resv = await db.query(
            `SELECT status, qty FROM inventory_reservations WHERE _ord_no = $1`, [order.ord_no]);
        expect(resv.rows).toEqual([expect.objectContaining({ status: 'active' })]);

        const cart = await db.query(
            `SELECT status, _ord_no FROM carts WHERE _ord_no = $1`, [order.ord_no]);
        expect(cart.rows[0].status).toBe('converted');
    });

    test('given subtotal of $50+ then shipping is free; heavy items add the weight surcharge', async () => {
        const v      = await makeVariant('BULK', { price: 30 });
        const heavy  = await makeVariant('HEAVY', { price: 40, product: heavyProductNo });
        await receive(v, 10); await receive(heavy, 5, 20);
        const user = await makeShopper('freeship', [
            { variantNo: v, qty: 2 },        // 60
            { variantNo: heavy, qty: 1 },    // 40, unit weight 55 lbs → 25.00 band
        ]);

        const res = await placeOrder(user);
        expect(res.status).toBe(201);
        const order = res.body.content.order;
        expect(order.subtotal).toBe(100);
        expect(order.shipping).toBe(25);     // free base + 25 heavy-band surcharge
    });

    test('given multiple heavy units then freight applies per unit; a heavy measured cut pays once', async () => {
        const heavy = await makeVariant('HEAVY2', { price: 40, product: heavyProductNo });
        await receive(heavy, 5, 20);
        const unitUser = await makeShopper('perunit', [{ variantNo: heavy, qty: 2 }]);   // two 55 lb packages

        const unitRes = await placeOrder(unitUser);
        expect(unitRes.status).toBe(201);
        expect(unitRes.body.content.order.shipping).toBe(50);   // free base (subtotal 80) + 2 × 25.00

        // A measured line is ONE package banded by the cut's total weight.
        const chainProd = Number((await db.query(
            `INSERT INTO products (name, status, sell_method, base_uom, min_cut_qty, weight_lbs)
             VALUES ($1, 'active', 'measure', 'ft', 2, 5) RETURNING product_no`,
            [`Chain ${RUN}`])).rows[0].product_no);
        const chain = await makeVariant('CHAIN', { price: 3, product: chainProd });
        await receive(chain, 100);
        const cutUser = await makeShopper('cutweight', [{ variantNo: chain, qty: 10 }]);   // 10 ft × 5 lb = 50 lb cut

        const cutRes = await placeOrder(cutUser);
        expect(cutRes.status).toBe(201);
        expect(cutRes.body.content.order.subtotal).toBe(30);
        expect(cutRes.body.content.order.shipping).toBe(9.95 + 25);   // base + one 40–70 lb package
    });

    test('given a measured product below its minimum cut then checkout is rejected', async () => {
        const rope = await makeVariant('ROPE', { price: 3, product: measureProductNo });
        await receive(rope, 100);
        const user = await makeShopper('mincut', [{ variantNo: rope, qty: 1 }]);   // min cut 2 ft

        const res = await placeOrder(user);
        expect(res.status).toBe(400);
        expect(res.body.outcome.message).toMatch(/minimum cut/);
    });

    test('given insufficient stock then 409 with per-line availability, and cart stays open', async () => {
        const v = await makeVariant('SHORT', { price: 5 });
        await receive(v, 2);
        const user = await makeShopper('short', [{ variantNo: v, qty: 8 }]);

        const res = await placeOrder(user);
        expect(res.status).toBe(409);
        expect(res.body.outcome.failures).toEqual([{ variant_no: v, qty: 8, qty_available: 2 }]);

        const cart = await db.query(
            `SELECT c.status FROM carts c JOIN users u ON u.id = c._user_id WHERE u.id = $1`, [user.id]);
        expect(cart.rows[0].status).toBe('open');   // workflow reverted one step
    });

    test('given the customer chooses backorder for the short line then the order places without reserving it', async () => {
        const ok    = await makeVariant('OK', { price: 20 });
        const short = await makeVariant('BO', { price: 5 });
        await receive(ok, 10); await receive(short, 0 + 1); // 1 on hand
        const user = await makeShopper('backorder', [
            { variantNo: ok, qty: 1 },
            { variantNo: short, qty: 5 },
        ]);

        const res = await placeOrder(user, { backorders: { [short]: 'backorder' } });
        expect(res.status).toBe(201);
        const order = res.body.content.order;
        expect(order.backordered).toEqual([short]);

        const lines = await db.query(
            `SELECT _variant_no, fulfillment_status FROM order_lines WHERE _ord_no = $1 ORDER BY ln_no`,
            [order.ord_no]);
        expect(lines.rows.map(l => l.fulfillment_status)).toEqual(['reserved', 'backordered']);

        const resv = await db.query(
            `SELECT _variant_no FROM inventory_reservations WHERE _ord_no = $1`, [order.ord_no]);
        expect(resv.rows).toHaveLength(1);   // only the in-stock line reserved
    });

    test('given the customer chooses notify-when-available then the line drops to stock_notifications', async () => {
        const ok    = await makeVariant('OK2', { price: 60 });
        const oos   = await makeVariant('OOS');
        await receive(ok, 5);
        const user = await makeShopper('notify', [
            { variantNo: ok, qty: 1 },
            { variantNo: oos, qty: 2 },
        ]);

        const res = await placeOrder(user, { backorders: { [oos]: 'notify' } });
        expect(res.status).toBe(201);

        const notif = await db.query(
            `SELECT email, status FROM stock_notifications WHERE _variant_no = $1`, [oos]);
        expect(notif.rows[0]).toMatchObject({ email: user.email, status: 'pending' });
    });
});

describe('given a placed order when the provider confirms payment then stock issues and status advances', () => {

    async function placedOrder(tag, qty = 2, price = 15) {
        const v = await makeVariant(tag, { price });
        await receive(v, 10, 4);
        const user = await makeShopper(tag.toLowerCase(), [{ variantNo: v, qty }]);
        const res = await placeOrder(user);
        expect(res.status).toBe(201);
        return { user, variantNo: v, order: res.body.content.order };
    }

    test('given webhook "authorized" then order is paid, reservations consumed, OUT rows FIFO-costed', async () => {
        const { order, variantNo } = await placedOrder('PAY');

        const confirm = await fakeConfirm(order.payment.intent_ref, 'authorized');
        expect(confirm.status).toBe(200);
        expect(confirm.body.content.outcome).toBe('paid');

        expect((await orderRow(order.ord_no)).status).toBe('paid');

        const resv = await db.query(
            `SELECT status FROM inventory_reservations WHERE _ord_no = $1`, [order.ord_no]);
        expect(resv.rows[0].status).toBe('consumed');

        const out = await db.query(
            `SELECT _trn_type, qty, unit_cost, unit_price FROM inventory_transactions
             WHERE _lnk_table = 'orders' AND _lnk_id = $1`, [order.ord_no]);
        expect(out.rows[0]).toMatchObject({ _trn_type: 'OUT' });
        expect(Number(out.rows[0].qty)).toBe(-2);
        expect(Number(out.rows[0].unit_cost)).toBe(4);      // FIFO cost stamped
        expect(Number(out.rows[0].unit_price)).toBe(15);    // selling price snapshot

        // status history recorded by trigger
        const hist = await db.query(
            `SELECT from_status, to_status FROM order_status_history WHERE _ord_no = $1`, [order.ord_no]);
        expect(hist.rows).toContainEqual({ from_status: 'pending_payment', to_status: 'paid' });
    });

    test('given a replayed webhook event then it is deduplicated (no double effects)', async () => {
        const { order } = await placedOrder('DUP');
        const event = fakeAdapter.makeEvent('authorized', order.payment.intent_ref);

        const first  = await PaymentsService.processEvent('fake', event);
        const replay = await PaymentsService.processEvent('fake', event);
        expect(first.outcome).toBe('paid');
        expect(replay.duplicate).toBe(true);

        const out = await db.query(
            `SELECT COUNT(*)::int AS n FROM inventory_transactions
             WHERE _lnk_table = 'orders' AND _lnk_id = $1`, [order.ord_no]);
        expect(out.rows[0].n).toBe(1);
    });

    test('given webhook "captured" arriving before "authorized" then the order is still paid and stock issued once', async () => {
        const { order } = await placedOrder('OOO');

        // Providers do not guarantee event order: capture lands first.
        const capture = await fakeConfirm(order.payment.intent_ref, 'captured');
        expect(capture.status).toBe(200);
        expect(capture.body.content.outcome).toBe('paid');

        expect((await orderRow(order.ord_no)).status).toBe('paid');
        const pay = await db.query(`SELECT status FROM payments WHERE _ord_no = $1`, [order.ord_no]);
        expect(pay.rows[0].status).toBe('captured');
        const resv = await db.query(
            `SELECT status FROM inventory_reservations WHERE _ord_no = $1`, [order.ord_no]);
        expect(resv.rows[0].status).toBe('consumed');

        // The late-arriving authorize event is a harmless no-op, not a regression.
        const late = await fakeConfirm(order.payment.intent_ref, 'authorized');
        expect(late.status).toBe(200);
        expect(late.body.content.outcome).toBe('noop');

        const out = await db.query(
            `SELECT COUNT(*)::int AS n FROM inventory_transactions
             WHERE _lnk_table = 'orders' AND _lnk_id = $1`, [order.ord_no]);
        expect(out.rows[0].n).toBe(1);   // stock issued exactly once
    });

    test('given webhook "failed" then reservations release and the order is payment_failed', async () => {
        const { order, variantNo } = await placedOrder('FAIL');
        await fakeConfirm(order.payment.intent_ref, 'failed');

        expect((await orderRow(order.ord_no)).status).toBe('payment_failed');
        const bal = await db.query(
            `SELECT qty_reserved FROM inventory_balances WHERE _variant_no = $1`, [variantNo]);
        expect(Number(bal.rows[0].qty_reserved)).toBe(0);
    });

    test('given the customer cancels a pending order then stock frees and the intent is voided', async () => {
        const { user, order, variantNo } = await placedOrder('CXL');

        const res = await request(app)
            .post(`/api/v1/checkout/${order.ord_no}/cancel`)
            .set('Authorization', `Bearer ${token(user)}`);
        expect(res.status).toBe(200);

        expect((await orderRow(order.ord_no)).status).toBe('cancelled');
        const pay = await db.query(
            `SELECT status FROM payments WHERE _ord_no = $1`, [order.ord_no]);
        expect(pay.rows[0].status).toBe('cancelled');
        const bal = await db.query(
            `SELECT qty_reserved FROM inventory_balances WHERE _variant_no = $1`, [variantNo]);
        expect(Number(bal.rows[0].qty_reserved)).toBe(0);
    });

    test('given a paid order when fulfillment ships it then the payment is captured (capture-on-fulfillment)', async () => {
        const { order } = await placedOrder('SHIP');
        await fakeConfirm(order.payment.intent_ref, 'authorized');

        const staff = await makeShopper('shipper');
        const res = await request(app)
            .post(`/api/v1/orders/${order.ord_no}/ship`)
            .set('Authorization', `Bearer ${token(staff, ['orders:fulfill'], ['fulfillment'])}`);
        expect(res.status).toBe(200);

        expect((await orderRow(order.ord_no)).status).toBe('shipped');
        const pay = await db.query(`SELECT status FROM payments WHERE _ord_no = $1`, [order.ord_no]);
        expect(pay.rows[0].status).toBe('captured');
        const lines = await db.query(
            `SELECT fulfillment_status FROM order_lines WHERE _ord_no = $1`, [order.ord_no]);
        expect(lines.rows[0].fulfillment_status).toBe('shipped');
    });

    test('given an order still awaiting payment when staff ship it then 409 and nothing is captured', async () => {
        const { order } = await placedOrder('EARLYSHIP');

        const staff = await makeShopper('earlyshipper');
        const res = await request(app)
            .post(`/api/v1/orders/${order.ord_no}/ship`)
            .set('Authorization', `Bearer ${token(staff, ['orders:fulfill'], ['fulfillment'])}`);
        expect(res.status).toBe(409);
        expect(res.body.outcome.message).toMatch(/not in a shippable state/);

        // Validate-before-capture: the order and the money are untouched.
        expect((await orderRow(order.ord_no)).status).toBe('pending_payment');
        const pay = await db.query(`SELECT status FROM payments WHERE _ord_no = $1`, [order.ord_no]);
        expect(pay.rows[0].status).toBe('created');
    });

    test('given a ship that died after capture when ship is re-run then it completes; a third call is 409', async () => {
        const { order } = await placedOrder('RESHIP');
        await fakeConfirm(order.payment.intent_ref, 'authorized');
        // Simulate the crash: payment captured, order never transitioned.
        await PaymentsService.captureForOrder(order.ord_no);

        const staff = await makeShopper('reshipper');
        const res = await request(app)
            .post(`/api/v1/orders/${order.ord_no}/ship`)
            .set('Authorization', `Bearer ${token(staff, ['orders:fulfill'], ['fulfillment'])}`);
        expect(res.status).toBe(200);   // idempotent capture lets fulfillment recover

        expect((await orderRow(order.ord_no)).status).toBe('shipped');
        const pay = await db.query(`SELECT status FROM payments WHERE _ord_no = $1`, [order.ord_no]);
        expect(pay.rows[0].status).toBe('captured');

        const again = await request(app)
            .post(`/api/v1/orders/${order.ord_no}/ship`)
            .set('Authorization', `Bearer ${token(staff, ['orders:fulfill'], ['fulfillment'])}`);
        expect(again.status).toBe(409);   // double-ship loses cleanly
    });

    test('given a captured payment when Finance refunds it then refund + payment status update with audit', async () => {
        const { order } = await placedOrder('REF');
        await fakeConfirm(order.payment.intent_ref, 'authorized');
        await PaymentsService.captureForOrder(order.ord_no);

        const fin = await makeShopper('finance');
        const denied = await request(app)
            .post(`/api/v1/payments/${order.ord_no}/refund`)
            .set('Authorization', `Bearer ${token(fin, ['orders:read'], ['fulfillment'])}`)
            .send({ amount: 10, reason: 'damaged in transit' });
        expect(denied.status).toBe(403);   // refunds:create required

        const res = await request(app)
            .post(`/api/v1/payments/${order.ord_no}/refund`)
            .set('Authorization', `Bearer ${token(fin, ['refunds:create'], ['finance'])}`)
            .send({ amount: 10, reason: 'damaged in transit' });
        expect(res.status).toBe(201);

        const refund = await db.query(`SELECT status, amount FROM refunds WHERE _ord_no = $1`, [order.ord_no]);
        expect(refund.rows[0].status).toBe('completed');
        const pay = await db.query(`SELECT status FROM payments WHERE _ord_no = $1`, [order.ord_no]);
        expect(pay.rows[0].status).toBe('partially_refunded');
    });

    test('given cumulative refunds then they cannot exceed the captured amount; the final one flips to refunded', async () => {
        const { order } = await placedOrder('REFCAP');   // total 39.95
        await fakeConfirm(order.payment.intent_ref, 'authorized');
        await PaymentsService.captureForOrder(order.ord_no);
        const fin  = await makeShopper('refcapfin');
        const auth = `Bearer ${token(fin, ['refunds:create'], ['finance'])}`;

        const first = await request(app).post(`/api/v1/payments/${order.ord_no}/refund`)
            .set('Authorization', auth).send({ amount: 30, reason: 'partial credit' });
        expect(first.status).toBe(201);

        const over = await request(app).post(`/api/v1/payments/${order.ord_no}/refund`)
            .set('Authorization', auth).send({ amount: 15, reason: 'too much' });
        expect(over.status).toBe(422);
        expect(over.body.outcome.message).toMatch(/exceeds the remaining refundable/);

        const rest = await request(app).post(`/api/v1/payments/${order.ord_no}/refund`)
            .set('Authorization', auth).send({ amount: 9.95, reason: 'remainder' });
        expect(rest.status).toBe(201);

        const pay = await db.query(`SELECT status FROM payments WHERE _ord_no = $1`, [order.ord_no]);
        expect(pay.rows[0].status).toBe('refunded');   // cumulative total reached, not partially_refunded
    });

    test('given an authorized (uncaptured) payment then refunding is rejected — undoing it is a cancel, not a refund', async () => {
        const { order } = await placedOrder('REFAUTH');
        await fakeConfirm(order.payment.intent_ref, 'authorized');

        const fin = await makeShopper('refauthfin');
        const res = await request(app).post(`/api/v1/payments/${order.ord_no}/refund`)
            .set('Authorization', `Bearer ${token(fin, ['refunds:create'], ['finance'])}`)
            .send({ amount: 10, reason: 'nope' });
        expect(res.status).toBe(409);

        const refunds = await db.query(
            `SELECT COUNT(*)::int AS n FROM refunds WHERE _ord_no = $1`, [order.ord_no]);
        expect(refunds.rows[0].n).toBe(0);
    });

    test('given reservations.ttl_minutes is reconfigured then new reservations honor it', async () => {
        await db.query(`UPDATE app_settings SET value = '45' WHERE key = 'reservations.ttl_minutes'`);
        try {
            const { order } = await placedOrder('TTLCFG');
            const r = await db.query(
                `SELECT expires_at, _create_ts FROM inventory_reservations WHERE _ord_no = $1`,
                [order.ord_no]);
            const minutes = (new Date(r.rows[0].expires_at) - new Date(r.rows[0]._create_ts)) / 60000;
            expect(Math.round(minutes)).toBe(45);
        } finally {
            await db.query(`UPDATE app_settings SET value = '15' WHERE key = 'reservations.ttl_minutes'`);
        }
    });

    test('given payment never confirms within the TTL then the sweeper fails the order and frees stock', async () => {
        const { order, variantNo } = await placedOrder('TTL');

        // Force expiry: backdate the reservation and the order
        await db.query(
            `UPDATE inventory_reservations SET expires_at = NOW() - INTERVAL '1 minute' WHERE _ord_no = $1`,
            [order.ord_no]);
        await db.query(
            `UPDATE orders SET placed_at = NOW() - INTERVAL '30 minutes' WHERE ord_no = $1`,
            [order.ord_no]);

        const swept = await PaymentsService.sweepExpired();
        expect(swept.released).toBeGreaterThanOrEqual(1);
        expect(swept.failed).toBeGreaterThanOrEqual(1);

        expect((await orderRow(order.ord_no)).status).toBe('payment_failed');
        const bal = await db.query(
            `SELECT qty_reserved FROM inventory_balances WHERE _variant_no = $1`, [variantNo]);
        expect(Number(bal.rows[0].qty_reserved)).toBe(0);
    });
});

describe('given a guest when they check out then an implicit account carries the order', () => {

    test('given a new email then guest user + customer are created and the order places', async () => {
        const v = await makeVariant('GUEST', { price: 25 });
        await receive(v, 10);
        const email = `guest-${RUN}@example.com`;

        const res = await request(app)
            .post('/api/v1/checkout/guest')
            .send({
                email, name: 'Gwen Guest', shipTo: SHIP_TO,
                items: [{ variant_no: v, qty: 2 }],
            });
        expect(res.status).toBe(201);
        const order = res.body.content.order;
        expect(order.total).toBe(50);   // 50 subtotal, free shipping at threshold

        const user = await db.query(
            `SELECT id, is_guest, role FROM users WHERE lower(email) = lower($1)`, [email]);
        expect(user.rows[0].is_guest).toBe(true);
        expect(user.rows[0].role).toBe('customer');

        // Second guest order with the same email reuses the account
        const res2 = await request(app)
            .post('/api/v1/checkout/guest')
            .send({ email, name: 'Gwen Guest', shipTo: SHIP_TO, items: [{ variant_no: v, qty: 1 }] });
        expect(res2.status).toBe(201);

        const users = await db.query(
            `SELECT COUNT(*)::int AS n FROM users WHERE lower(email) = lower($1)`, [email]);
        expect(users.rows[0].n).toBe(1);

        const orders = await db.query(
            `SELECT COUNT(*)::int AS n FROM orders o
             JOIN customers c ON c.id = o._customer_id WHERE c.email = $1`, [email]);
        expect(orders.rows[0].n).toBe(2);
    });

    test('given the same variant listed twice then the lines merge into one', async () => {
        const v = await makeVariant('GDUP', { price: 10 });
        await receive(v, 10);

        const res = await request(app)
            .post('/api/v1/checkout/guest')
            .send({ email: `guest-dup-${RUN}@example.com`, name: 'Dup Guest', shipTo: SHIP_TO,
                    items: [{ variant_no: v, qty: 2 }, { variant_no: v, qty: 1 }] });
        expect(res.status).toBe(201);

        const lines = await db.query(
            `SELECT qty FROM order_lines WHERE _ord_no = $1`, [res.body.content.order.ord_no]);
        expect(lines.rows).toHaveLength(1);
        expect(Number(lines.rows[0].qty)).toBe(3);
    });

    test('given no valid email then guest checkout is rejected', async () => {
        const res = await request(app)
            .post('/api/v1/checkout/guest')
            .send({ email: 'not-an-email', name: 'X', items: [{ variant_no: 1, qty: 1 }] });
        expect(res.status).toBe(400);
    });
});
