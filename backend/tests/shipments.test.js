'use strict';

/**
 * Shipment tracking tests: ship records a shipments row with its lines,
 * carrier/tracking flow through the API, tracking is correctable afterward,
 * and customers see their shipments on the order payload.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
process.env.PAYMENT_PROVIDER = 'fake';

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');

const RUN = Date.now();
let mainWh, productNo, fulfiller;

function token(user, perms = [], roles = ['customer']) {
    return jwt.sign(
        { sub: user.id, email: user.email, role: user.role || 'customer', roles, perms },
        process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }
    );
}

async function makeVariant(tag, price = 12) {
    const res = await db.query(
        `INSERT INTO product_variants (_product_no, sku, price)
         VALUES ($1, $2, $3) RETURNING variant_no`,
        [productNo, `SHP-${RUN}-${tag}`, price]
    );
    return Number(res.rows[0].variant_no);
}

async function makeShopper(tag, cartItems) {
    const u = await db.query(
        `INSERT INTO users (email, role, status) VALUES ($1, 'customer', 'active') RETURNING id, email, role`,
        [`shp-${tag}-${RUN}@example.com`]
    );
    const user = u.rows[0];
    await db.query(
        `INSERT INTO user_roles (user_id, role_no) SELECT $1, role_no FROM roles WHERE code = 'customer'`,
        [user.id]);
    await db.query(
        `INSERT INTO customers (user_id, name, email) VALUES ($1, $2, $3)`,
        [user.id, `Shipper ${tag}`, user.email]);
    const cart = await db.query(
        `INSERT INTO carts (_user_id, status) VALUES ($1, 'open') RETURNING cart_no`, [user.id]);
    for (const it of cartItems) {
        await db.query(
            `INSERT INTO cart_items (_cart_no, _variant_no, qty) VALUES ($1, $2, $3)`,
            [cart.rows[0].cart_no, it.variantNo, it.qty]);
    }
    return user;
}

/** Paid order with all lines reserved, ready to ship. */
async function paidOrder(tag, qty = 2) {
    const variantNo = await makeVariant(tag);
    await db.query(
        `INSERT INTO inventory_transactions (_trn_type, _variant_no, _warehouse_no, qty, unit_cost)
         VALUES ('IN', $1, $2, 20, 3)`,
        [variantNo, mainWh]);
    const user = await makeShopper(tag.toLowerCase(), [{ variantNo, qty }]);

    const placed = await request(app)
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${token(user)}`)
        .send({ shipTo: { name: 'Ship Test', address: '1 Demo St', city: 'Springfield',
                          state: 'IL', zip: '62701', country: 'US' } });
    expect(placed.status).toBe(201);
    const order = placed.body.content.order;

    const confirm = await request(app)
        .post('/api/v1/payments/fake/confirm')
        .send({ intent_ref: order.payment.intent_ref, outcome: 'authorized' });
    expect(confirm.status).toBe(200);
    return { user, order };
}

function ship(ordNo, body = {}, perms = ['orders:fulfill']) {
    return request(app)
        .post(`/api/v1/orders/${ordNo}/ship`)
        .set('Authorization', `Bearer ${token(fulfiller, perms, ['admin'])}`)
        .send(body);
}

beforeAll(async () => {
    mainWh = (await db.query(`SELECT warehouse_no FROM warehouses WHERE code = 'MAIN'`)).rows[0].warehouse_no;
    productNo = (await db.query(
        `INSERT INTO products (name, status, sell_method, base_uom)
         VALUES ($1, 'active', 'unit', 'each') RETURNING product_no`,
        [`Shipment Test Product ${RUN}`]
    )).rows[0].product_no;
    fulfiller = (await db.query(
        `INSERT INTO users (email, role, status) VALUES ($1, 'admin', 'active') RETURNING id, email, role`,
        [`shp-staff-${RUN}@example.com`]
    )).rows[0];
});

afterAll(async () => {
    await pool.end();
});

describe('given a paid order when staff ship it then a shipment records the package and its lines', () => {

    test('given carrier and tracking on the ship call then the shipment row carries them', async () => {
        const { order } = await paidOrder('FULL');

        const res = await ship(order.ord_no, {
            carrier: 'UPS', tracking_no: `1Z-${RUN}`, notes: 'two boxes' });
        expect(res.status).toBe(200);
        expect(res.body.content.status).toBe('shipped');
        const shipmentNo = res.body.content.shipment_no;
        expect(shipmentNo).toBeDefined();

        const s = await db.query(`SELECT * FROM shipments WHERE shipment_no = $1`, [shipmentNo]);
        expect(s.rows[0]).toMatchObject({
            carrier: 'UPS', tracking_no: `1Z-${RUN}`, notes: 'two boxes' });
        expect(Number(s.rows[0]._ord_no)).toBe(Number(order.ord_no));
        expect(Number(s.rows[0].shipped_by)).toBe(Number(fulfiller.id));

        const lines = await db.query(
            `SELECT sl.qty FROM shipment_lines sl WHERE sl._shipment_no = $1`, [shipmentNo]);
        expect(lines.rows).toHaveLength(1);
        expect(Number(lines.rows[0].qty)).toBe(2);
    });

    test('given no package details then the ship still succeeds with an empty shipment record', async () => {
        const { order } = await paidOrder('BARE');

        const res = await ship(order.ord_no);
        expect(res.status).toBe(200);

        const s = await db.query(
            `SELECT carrier, tracking_no FROM shipments WHERE _ord_no = $1`, [order.ord_no]);
        expect(s.rows).toHaveLength(1);
        expect(s.rows[0]).toMatchObject({ carrier: null, tracking_no: null });
    });

    test('given a shipped order when the customer reads it then shipments with tracking are included', async () => {
        const { user, order } = await paidOrder('CUST');
        await ship(order.ord_no, { carrier: 'FedEx', tracking_no: `FX-${RUN}` });

        const res = await request(app)
            .get(`/api/v1/orders/${order.ord_no}`)
            .set('Authorization', `Bearer ${token(user)}`);
        expect(res.status).toBe(200);
        const shipments = res.body.content.order.shipments;
        expect(shipments).toHaveLength(1);
        expect(shipments[0]).toMatchObject({ carrier: 'FedEx', tracking_no: `FX-${RUN}` });
        expect(shipments[0].lines).toHaveLength(1);
        expect(Number(shipments[0].lines[0].qty)).toBe(2);
    });
});

describe('given an existing shipment when tracking details arrive later then staff can complete them', () => {

    test('given a partial update then provided fields change and others are kept', async () => {
        const { order } = await paidOrder('EDIT');
        const shipped = await ship(order.ord_no, { carrier: 'USPS' });
        const shipmentNo = shipped.body.content.shipment_no;

        const res = await request(app)
            .put(`/api/v1/orders/${order.ord_no}/shipments/${shipmentNo}`)
            .set('Authorization', `Bearer ${token(fulfiller, ['orders:fulfill'], ['admin'])}`)
            .send({ tracking_no: `9400-${RUN}` });
        expect(res.status).toBe(200);
        expect(res.body.content.shipment).toMatchObject({
            carrier: 'USPS', tracking_no: `9400-${RUN}` });
    });

    test('given a shipment addressed through the wrong order then 404', async () => {
        const { order } = await paidOrder('WRONG');
        const other     = await paidOrder('OTHER');
        const shipped   = await ship(order.ord_no, {});
        const shipmentNo = shipped.body.content.shipment_no;

        const res = await request(app)
            .put(`/api/v1/orders/${other.order.ord_no}/shipments/${shipmentNo}`)
            .set('Authorization', `Bearer ${token(fulfiller, ['orders:fulfill'], ['admin'])}`)
            .send({ tracking_no: 'X' });
        expect(res.status).toBe(404);
    });

    test('given a caller without orders:fulfill then 403', async () => {
        const res = await request(app)
            .put(`/api/v1/orders/1/shipments/1`)
            .set('Authorization', `Bearer ${token(fulfiller, ['orders:read'], ['admin'])}`)
            .send({ tracking_no: 'X' });
        expect(res.status).toBe(403);
    });

    test('given an empty update then 400', async () => {
        const { order } = await paidOrder('EMPTY');
        const shipped = await ship(order.ord_no, {});
        const res = await request(app)
            .put(`/api/v1/orders/${order.ord_no}/shipments/${shipped.body.content.shipment_no}`)
            .set('Authorization', `Bearer ${token(fulfiller, ['orders:fulfill'], ['admin'])}`)
            .send({});
        expect(res.status).toBe(400);
    });
});
