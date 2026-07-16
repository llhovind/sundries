'use strict';

/**
 * Restock pipeline integration tests: backorder fulfillment (arriving stock
 * is allocated to paid orders oldest-first and issued at the order line's
 * price), partial → complete shipment, unpaid orders never allocated, and
 * back-in-stock notifications fired exactly once.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
process.env.PAYMENT_PROVIDER = 'fake';

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');
const RestockService   = require('../services/restockService');

const RUN = Date.now();
let mainWh, productNo;

function token(user, perms = [], roles = ['customer']) {
    return jwt.sign(
        { sub: user.id, email: user.email, role: user.role || 'customer', roles, perms },
        process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }
    );
}
const staffToken = () => token({ id: 1, email: 'rs@t.l', role: 'admin' }, ['orders:fulfill'], ['fulfillment']);

async function makeVariant(tag, price = 10) {
    const res = await db.query(
        `INSERT INTO product_variants (_product_no, sku, price) VALUES ($1, $2, $3) RETURNING variant_no`,
        [productNo, `RS-${RUN}-${tag}`, price]);
    return Number(res.rows[0].variant_no);
}

async function receive(variantNo, qty, unitCost = 3) {
    await db.query(
        `INSERT INTO inventory_transactions (_trn_type, _variant_no, _warehouse_no, qty, unit_cost)
         VALUES ('IN', $1, $2, $3, $4)`, [variantNo, mainWh, qty, unitCost]);
}

async function makeShopper(tag, cartItems = []) {
    const u = await db.query(
        `INSERT INTO users (email, role, status) VALUES ($1, 'customer', 'active') RETURNING id, email, role`,
        [`rs-${tag}-${RUN}@example.com`]);
    const user = u.rows[0];
    await db.query(`INSERT INTO user_roles (user_id, role_no) SELECT $1, role_no FROM roles WHERE code='customer'`, [user.id]);
    await db.query(`INSERT INTO customers (user_id, name, email) VALUES ($1, $2, $3)`, [user.id, `RS ${tag}`, user.email]);
    const cart = await db.query(`INSERT INTO carts (_user_id, status) VALUES ($1, 'open') RETURNING cart_no`, [user.id]);
    for (const it of cartItems) {
        await db.query(`INSERT INTO cart_items (_cart_no, _variant_no, qty) VALUES ($1, $2, $3)`,
            [cart.rows[0].cart_no, it.variantNo, it.qty]);
    }
    return user;
}

const SHIP_TO = { name: 'RS', address: '1 St', city: 'Springfield', state: 'IL', zip: '62701', country: 'US' };

async function placeOrder(user, body = {}) {
    const res = await request(app).post('/api/v1/checkout')
        .set('Authorization', `Bearer ${token(user)}`)
        .send({ shipTo: SHIP_TO, ...body });
    expect(res.status).toBe(201);
    return res.body.content.order;
}

async function payOrder(order) {
    const res = await request(app).post('/api/v1/payments/fake/confirm')
        .send({ intent_ref: order.payment.intent_ref, outcome: 'authorized' });
    expect(res.status).toBe(200);
}

async function shipOrder(ordNo) {
    return request(app).post(`/api/v1/orders/${ordNo}/ship`)
        .set('Authorization', `Bearer ${staffToken()}`);
}

async function lineRows(ordNo) {
    return db.query(
        `SELECT id, ln_no, _variant_no, fulfillment_status, _warehouse_no
         FROM order_lines WHERE _ord_no = $1 ORDER BY ln_no`, [ordNo]).then(r => r.rows);
}

beforeAll(async () => {
    mainWh = Number((await db.query(`SELECT warehouse_no FROM warehouses WHERE code = 'MAIN'`)).rows[0].warehouse_no);
    productNo = Number((await db.query(
        `INSERT INTO products (name, status) VALUES ($1, 'active') RETURNING product_no`,
        [`Restock Product ${RUN}`])).rows[0].product_no);
});

afterAll(async () => {
    await pool.end();
});

describe('given a paid order with backordered lines when stock arrives then the restock job fills them', () => {

    test('given partial ship then arrival then re-ship then the order completes with one capture', async () => {
        const inStock = await makeVariant('A', 15);
        const backord = await makeVariant('B', 8);
        await receive(inStock, 5);

        const user  = await makeShopper('flow', [
            { variantNo: inStock, qty: 1 }, { variantNo: backord, qty: 2 }]);
        const order = await placeOrder(user, { backorders: { [backord]: 'backorder' } });
        await payOrder(order);

        // First shipment: only the reserved line goes; order is partial.
        const ship1 = await shipOrder(order.ord_no);
        expect(ship1.status).toBe(200);
        expect(ship1.body.content.status).toBe('partially_shipped');
        let lines = await lineRows(order.ord_no);
        expect(lines.map(l => l.fulfillment_status)).toEqual(['shipped', 'backordered']);
        const pay1 = await db.query(`SELECT status FROM payments WHERE _ord_no = $1`, [order.ord_no]);
        expect(pay1.rows[0].status).toBe('captured');   // full capture at first ship

        // Stock arrives → the job allocates and issues at the order's price.
        await receive(backord, 10, 3);
        const result = await RestockService.processArrivals();
        expect(result.fulfilled).toBeGreaterThanOrEqual(1);

        lines = await lineRows(order.ord_no);
        expect(lines[1].fulfillment_status).toBe('reserved');
        expect(lines[1]._warehouse_no).not.toBeNull();

        const out = await db.query(
            `SELECT qty, unit_price, unit_cost FROM inventory_transactions
             WHERE _lnk_table = 'orders' AND _lnk_id = $1 AND _ln_no = 2 AND _trn_type = 'OUT'`,
            [order.ord_no]);
        expect(out.rows).toHaveLength(1);
        expect(Number(out.rows[0].qty)).toBe(-2);
        expect(Number(out.rows[0].unit_price)).toBe(8);    // order line price
        expect(Number(out.rows[0].unit_cost)).toBe(3);     // arriving FIFO cost

        const resv = await db.query(
            `SELECT status FROM inventory_reservations WHERE _ord_no = $1 AND _variant_no = $2`,
            [order.ord_no, backord]);
        expect(resv.rows[0].status).toBe('consumed');      // allocation is documented

        const bal = await db.query(
            `SELECT qty_on_hand, qty_reserved FROM inventory_balances
             WHERE _variant_no = $1 AND _warehouse_no = $2`, [backord, mainWh]);
        expect(Number(bal.rows[0].qty_on_hand)).toBe(8);   // 10 in − 2 issued
        expect(Number(bal.rows[0].qty_reserved)).toBe(0);

        // Second shipment completes the order; capture is a no-op.
        const ship2 = await shipOrder(order.ord_no);
        expect(ship2.status).toBe(200);
        expect(ship2.body.content.status).toBe('shipped');
        lines = await lineRows(order.ord_no);
        expect(lines.map(l => l.fulfillment_status)).toEqual(['shipped', 'shipped']);
    });

    test('given an unpaid order then arriving stock is never allocated to it', async () => {
        const v = await makeVariant('UNPAID');
        const user  = await makeShopper('unpaid', [{ variantNo: v, qty: 1 }]);
        const order = await placeOrder(user, { backorders: { [v]: 'backorder' } });
        // no payment confirmation — order stays pending_payment

        await receive(v, 5);
        await RestockService.processArrivals();

        const lines = await lineRows(order.ord_no);
        expect(lines[0].fulfillment_status).toBe('backordered');
        const bal = await db.query(
            `SELECT qty_on_hand FROM inventory_balances WHERE _variant_no = $1 AND _warehouse_no = $2`,
            [v, mainWh]);
        expect(Number(bal.rows[0].qty_on_hand)).toBe(5);   // untouched
    });

    test('given two waiting orders and stock for one then the older order wins; the younger cannot ship yet', async () => {
        const v = await makeVariant('FAIR', 5);

        const older = await placeOrder(
            await makeShopper('fair1', [{ variantNo: v, qty: 3 }]), { backorders: { [v]: 'backorder' } });
        await payOrder(older);
        const younger = await placeOrder(
            await makeShopper('fair2', [{ variantNo: v, qty: 3 }]), { backorders: { [v]: 'backorder' } });
        await payOrder(younger);

        // Fully-backordered orders have nothing ready to ship.
        const early = await shipOrder(younger.ord_no);
        expect(early.status).toBe(409);
        expect(early.body.outcome.message).toMatch(/No lines are ready to ship/);

        await receive(v, 4);   // enough for one order, not both
        await RestockService.processArrivals();

        expect((await lineRows(older.ord_no))[0].fulfillment_status).toBe('reserved');
        expect((await lineRows(younger.ord_no))[0].fulfillment_status).toBe('backordered');
    });
});

describe('given pending back-in-stock requests when stock arrives then customers are told exactly once', () => {

    test('given a notify checkout choice then arrival marks the request notified, once', async () => {
        const inStock = await makeVariant('NOK', 60);
        const wanted  = await makeVariant('WANT');
        await receive(inStock, 5);

        const user = await makeShopper('notify', [
            { variantNo: inStock, qty: 1 }, { variantNo: wanted, qty: 2 }]);
        await placeOrder(user, { backorders: { [wanted]: 'notify' } });

        let notif = await db.query(
            `SELECT status FROM stock_notifications WHERE _variant_no = $1`, [wanted]);
        expect(notif.rows[0].status).toBe('pending');

        // No stock yet → nothing to announce.
        await RestockService.processArrivals();
        notif = await db.query(`SELECT status FROM stock_notifications WHERE _variant_no = $1`, [wanted]);
        expect(notif.rows[0].status).toBe('pending');

        await receive(wanted, 3);
        await RestockService.processArrivals();
        notif = await db.query(
            `SELECT status, notified_at, email FROM stock_notifications WHERE _variant_no = $1`, [wanted]);
        expect(notif.rows).toHaveLength(1);
        expect(notif.rows[0].status).toBe('notified');
        expect(notif.rows[0].notified_at).not.toBeNull();
        expect(notif.rows[0].email).toBe(user.email);

        // Re-running does not re-notify.
        const firstNotifiedAt = notif.rows[0].notified_at;
        await RestockService.processArrivals();
        notif = await db.query(
            `SELECT status, notified_at FROM stock_notifications WHERE _variant_no = $1`, [wanted]);
        expect(notif.rows[0].status).toBe('notified');
        expect(new Date(notif.rows[0].notified_at).getTime()).toBe(new Date(firstNotifiedAt).getTime());
    });
});
