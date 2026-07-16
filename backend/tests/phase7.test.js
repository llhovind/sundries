'use strict';

/**
 * Phase 7 integration tests: promotion engine (validation, checkout pricing,
 * atomic redemption), the RMA state machine (request → approve → receive with
 * restock → refund), and compliance request processing.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
process.env.PAYMENT_PROVIDER = 'fake';

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');
const ComplianceService = require('../services/complianceService');
const Jobs = require('../services/jobs');

const RUN = Date.now();
let mainWh, productNo;

function token(user, perms = [], roles = ['customer']) {
    return jwt.sign(
        { sub: user.id, email: user.email, role: user.role || 'customer', roles, perms },
        process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }
    );
}
const adminToken = () => token({ id: 1, email: 'admin@t.l', role: 'admin' },
    ['promotions:manage', 'orders:fulfill', 'rma:manage', 'refunds:create', 'customers:write'], ['admin']);

async function makeVariant(tag, price = 10) {
    const res = await db.query(
        `INSERT INTO product_variants (_product_no, sku, price) VALUES ($1, $2, $3) RETURNING variant_no`,
        [productNo, `P7-${RUN}-${tag}`, price]);
    const v = Number(res.rows[0].variant_no);
    await db.query(
        `INSERT INTO inventory_transactions (_trn_type, _variant_no, _warehouse_no, qty, unit_cost)
         VALUES ('IN', $1, $2, 50, 4)`, [v, mainWh]);
    return v;
}

async function makeShopper(tag, cartItems = []) {
    const u = await db.query(
        `INSERT INTO users (email, role, status) VALUES ($1, 'customer', 'active') RETURNING id, email, role`,
        [`p7-${tag}-${RUN}@example.com`]);
    const user = u.rows[0];
    await db.query(`INSERT INTO user_roles (user_id, role_no) SELECT $1, role_no FROM roles WHERE code='customer'`, [user.id]);
    await db.query(`INSERT INTO customers (user_id, name, email) VALUES ($1, $2, $3)`, [user.id, `P7 ${tag}`, user.email]);
    if (cartItems.length) {
        const cart = await db.query(`INSERT INTO carts (_user_id, status) VALUES ($1, 'open') RETURNING cart_no`, [user.id]);
        for (const it of cartItems) {
            await db.query(`INSERT INTO cart_items (_cart_no, _variant_no, qty) VALUES ($1, $2, $3)`,
                [cart.rows[0].cart_no, it.variantNo, it.qty]);
        }
    }
    return user;
}

const SHIP_TO = { name: 'P7', address: '1 St', city: 'Springfield', state: 'IL', zip: '62701', country: 'US' };

async function checkout(user, body = {}) {
    return request(app).post('/api/v1/checkout')
        .set('Authorization', `Bearer ${token(user)}`)
        .send({ shipTo: SHIP_TO, ...body });
}

async function makePromo(body) {
    return request(app).post('/api/v1/promotions')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ status: 'active', ...body });
}

/** Places, pays, and ships an order — the precondition for a return. */
async function shippedOrder(tag, qty = 2, price = 15) {
    const v = await makeVariant(tag, price);
    const user = await makeShopper(tag.toLowerCase(), [{ variantNo: v, qty }]);
    const placed = await checkout(user);
    expect(placed.status).toBe(201);
    const order = placed.body.content.order;
    await request(app).post('/api/v1/payments/fake/confirm')
        .send({ intent_ref: order.payment.intent_ref, outcome: 'authorized' });
    const ship = await request(app).post(`/api/v1/orders/${order.ord_no}/ship`)
        .set('Authorization', `Bearer ${adminToken()}`);
    expect(ship.status).toBe(200);
    const lines = await db.query(`SELECT id, ln_no, qty FROM order_lines WHERE _ord_no = $1`, [order.ord_no]);
    return { user, order, variantNo: v, line: lines.rows[0] };
}

beforeAll(async () => {
    mainWh = (await db.query(`SELECT warehouse_no FROM warehouses WHERE code = 'MAIN'`)).rows[0].warehouse_no;
    productNo = Number((await db.query(
        `INSERT INTO products (name, status) VALUES ($1, 'active') RETURNING product_no`,
        [`Phase7 Product ${RUN}`])).rows[0].product_no);
});

afterAll(async () => {
    await Jobs.stop();
    await pool.end();
});

describe('given promotion codes when applied at checkout then pricing and redemption budgets hold', () => {

    test('given a 10% code then discount, tax base and totals are correct and redemption is recorded', async () => {
        const code = `SAVE10-${RUN}`;
        const created = await makePromo({ code, name: 'Ten percent', promo_type: 'percent', value: 10 });
        expect(created.status).toBe(201);

        const v = await makeVariant('PCT', 10);
        const user = await makeShopper('pct', [{ variantNo: v, qty: 3 }]);   // subtotal 30
        const res = await checkout(user, { promoCode: code });
        expect(res.status).toBe(201);

        const order = res.body.content.order;
        expect(order.discount).toBe(3);              // 10% of 30
        expect(order.shipping).toBe(9.95);           // threshold checks the pre-discount subtotal
        expect(order.total).toBe(27 + 9.95);
        expect(order.promo).toBe(code.toUpperCase());

        const redemption = await db.query(
            `SELECT pr.amount, p.redemption_count
             FROM promotion_redemptions pr JOIN promotions p ON p.promo_no = pr._promo_no
             WHERE pr._ord_no = $1`, [order.ord_no]);
        expect(Number(redemption.rows[0].amount)).toBe(3);
        expect(redemption.rows[0].redemption_count).toBe(1);

        const dbOrder = await db.query(`SELECT discount_amt FROM orders WHERE ord_no = $1`, [order.ord_no]);
        expect(Number(dbOrder.rows[0].discount_amt)).toBe(3);
    });

    test('given a free_shipping code then the base rate is waived', async () => {
        const code = `FREESHIP-${RUN}`;
        await makePromo({ code, name: 'Free shipping', promo_type: 'free_shipping' });
        const v = await makeVariant('FS', 10);
        const user = await makeShopper('fs', [{ variantNo: v, qty: 2 }]);    // subtotal 20 → would be 9.95
        const res = await checkout(user, { promoCode: code });
        expect(res.status).toBe(201);
        expect(res.body.content.order.shipping).toBe(0);
        expect(res.body.content.order.total).toBe(20);
    });

    test('given max_redemptions=1 then the second checkout with the code is rejected', async () => {
        const code = `ONCE-${RUN}`;
        await makePromo({ code, name: 'One shot', promo_type: 'fixed_amount', value: 5, max_redemptions: 1 });
        const v = await makeVariant('ONCE', 10);

        const first = await makeShopper('once1', [{ variantNo: v, qty: 1 }]);
        expect((await checkout(first, { promoCode: code })).status).toBe(201);

        const second = await makeShopper('once2', [{ variantNo: v, qty: 1 }]);
        const res = await checkout(second, { promoCode: code });
        expect(res.status).toBe(400);
        expect(res.body.outcome.message).toMatch(/fully redeemed/);
    });

    test('given an expired or unknown code then validation rejects with a customer-safe message', async () => {
        const code = `EXPIRED-${RUN}`;
        await makePromo({ code, name: 'Old', promo_type: 'percent', value: 20,
                          ends_at: new Date(Date.now() - 86400000).toISOString() });

        const expired = await request(app).post('/api/v1/promotions/validate')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ code, subtotal: 100 });
        expect(expired.status).toBe(400);
        expect(expired.body.outcome.message).toMatch(/expired/);

        const unknown = await request(app).post('/api/v1/promotions/validate')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ code: 'NOPE', subtotal: 100 });
        expect(unknown.status).toBe(400);
    });

    test('given a customer without promotions:manage then management endpoints are 403', async () => {
        const user = await makeShopper('perm');
        const res = await request(app).post('/api/v1/promotions')
            .set('Authorization', `Bearer ${token(user)}`)
            .send({ code: 'HACK', name: 'x', promo_type: 'percent', value: 99 });
        expect(res.status).toBe(403);
    });
});

describe('given a shipped order when returned then the RMA lifecycle drives stock and money correctly', () => {

    test('given the full lifecycle then request → approve → receive(restock) → refund → close', async () => {
        const { user, order, variantNo, line } = await shippedOrder('RMA1');

        // request (customer, own order)
        const req1 = await request(app).post('/api/v1/rmas')
            .set('Authorization', `Bearer ${token(user)}`)
            .send({ ord_no: order.ord_no, reason: 'wrong size',
                    lines: [{ order_line_id: line.id, qty: 2, condition: 'unopened' }] });
        expect(req1.status).toBe(201);
        const rmaNo = req1.body.content.rma_no;

        // refund before receive → 409 (state machine)
        const early = await request(app).post(`/api/v1/rmas/${rmaNo}/refund`)
            .set('Authorization', `Bearer ${adminToken()}`).send({ amount: 30, reason: 'x' });
        expect(early.status).toBe(409);

        // approve (staff)
        const approve = await request(app).put(`/api/v1/rmas/${rmaNo}/status`)
            .set('Authorization', `Bearer ${adminToken()}`).send({ status: 'approved' });
        expect(approve.status).toBe(200);

        // receive with restock → RET at the original FIFO cost, stock returns
        const balBefore = await db.query(
            `SELECT qty_on_hand FROM inventory_balances WHERE _variant_no = $1 AND _warehouse_no = $2`,
            [variantNo, mainWh]);
        const rmaLines = await db.query(`SELECT id FROM rma_lines WHERE _rma_no = $1`, [rmaNo]);
        const receive = await request(app).post(`/api/v1/rmas/${rmaNo}/receive`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ lines: [{ rma_line_id: rmaLines.rows[0].id, restock: true }] });
        expect(receive.status).toBe(200);
        expect(receive.body.content.restocked_transactions).toHaveLength(1);

        const balAfter = await db.query(
            `SELECT qty_on_hand FROM inventory_balances WHERE _variant_no = $1 AND _warehouse_no = $2`,
            [variantNo, mainWh]);
        expect(Number(balAfter.rows[0].qty_on_hand) - Number(balBefore.rows[0].qty_on_hand)).toBe(2);

        const ret = await db.query(
            `SELECT _trn_type, qty, unit_cost FROM inventory_transactions
             WHERE _lnk_table = 'rmas' AND _lnk_id = $1`, [rmaNo]);
        expect(ret.rows[0]._trn_type).toBe('RET');
        expect(Number(ret.rows[0].unit_cost)).toBe(4);     // original FIFO cost, not price

        // refund (Finance) — links refund to the RMA
        const refund = await request(app).post(`/api/v1/rmas/${rmaNo}/refund`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ amount: 30, reason: 'RMA credit' });
        expect(refund.status).toBe(201);

        const refRow = await db.query(`SELECT _rma_no, status FROM refunds WHERE _ord_no = $1`, [order.ord_no]);
        expect(Number(refRow.rows[0]._rma_no)).toBe(Number(rmaNo));
        expect(refRow.rows[0].status).toBe('completed');

        // close
        const close = await request(app).put(`/api/v1/rmas/${rmaNo}/status`)
            .set('Authorization', `Bearer ${adminToken()}`).send({ status: 'closed' });
        expect(close.status).toBe(200);
    });

    test('given someone else\'s order then a customer cannot open an RMA on it', async () => {
        const { order, line } = await shippedOrder('RMA2');
        const stranger = await makeShopper('stranger');
        const res = await request(app).post('/api/v1/rmas')
            .set('Authorization', `Bearer ${token(stranger)}`)
            .send({ ord_no: order.ord_no, reason: 'not mine',
                    lines: [{ order_line_id: line.id, qty: 1 }] });
        expect(res.status).toBe(404);
    });

    test('given an unshipped order or an oversize qty then the request is rejected', async () => {
        const v = await makeVariant('RMA3', 10);
        const user = await makeShopper('rma3', [{ variantNo: v, qty: 1 }]);
        const placed = await checkout(user);
        const order = placed.body.content.order;   // pending_payment — not shipped
        const lines = await db.query(`SELECT id FROM order_lines WHERE _ord_no = $1`, [order.ord_no]);

        const unshipped = await request(app).post('/api/v1/rmas')
            .set('Authorization', `Bearer ${token(user)}`)
            .send({ ord_no: order.ord_no, reason: 'x', lines: [{ order_line_id: lines.rows[0].id, qty: 1 }] });
        expect(unshipped.status).toBe(409);

        const shipped = await shippedOrder('RMA4');
        const oversize = await request(app).post('/api/v1/rmas')
            .set('Authorization', `Bearer ${token(shipped.user)}`)
            .send({ ord_no: shipped.order.ord_no, reason: 'x',
                    lines: [{ order_line_id: shipped.line.id, qty: 99 }] });
        expect(oversize.status).toBe(400);
    });

    test('given cumulative returns then a line cannot be over-returned across RMAs; a rejection frees its claim', async () => {
        const { user, order, line } = await shippedOrder('RMA6');   // qty 2 purchased

        const first = await request(app).post('/api/v1/rmas')
            .set('Authorization', `Bearer ${token(user)}`)
            .send({ ord_no: order.ord_no, reason: 'first', lines: [{ order_line_id: line.id, qty: 2 }] });
        expect(first.status).toBe(201);
        const firstRma = first.body.content.rma_no;

        // The open RMA holds the full budget — a second return is rejected.
        const second = await request(app).post('/api/v1/rmas')
            .set('Authorization', `Bearer ${token(user)}`)
            .send({ ord_no: order.ord_no, reason: 'second', lines: [{ order_line_id: line.id, qty: 1 }] });
        expect(second.status).toBe(409);
        expect(second.body.outcome.message).toMatch(/remaining returnable/);

        // Rejection is terminal and hands the claim back.
        const reject = await request(app).put(`/api/v1/rmas/${firstRma}/status`)
            .set('Authorization', `Bearer ${adminToken()}`).send({ status: 'rejected' });
        expect(reject.status).toBe(200);

        const closeRejected = await request(app).put(`/api/v1/rmas/${firstRma}/status`)
            .set('Authorization', `Bearer ${adminToken()}`).send({ status: 'closed' });
        expect(closeRejected.status).toBe(409);   // no rejected → closed drift

        const retry = await request(app).post('/api/v1/rmas')
            .set('Authorization', `Bearer ${token(user)}`)
            .send({ ord_no: order.ord_no, reason: 'retry', lines: [{ order_line_id: line.id, qty: 2 }] });
        expect(retry.status).toBe(201);
    });

    test('given a partially shipped order then shipped lines are returnable and backordered lines are not', async () => {
        const stocked   = await makeVariant('PS-A', 15);
        const unstocked = (await db.query(
            `INSERT INTO product_variants (_product_no, sku, price) VALUES ($1, $2, 8) RETURNING variant_no`,
            [productNo, `P7-${RUN}-PS-B`])).rows[0].variant_no;

        const user = await makeShopper('partial', [
            { variantNo: stocked, qty: 1 }, { variantNo: Number(unstocked), qty: 2 }]);
        const placed = await checkout(user, { backorders: { [unstocked]: 'backorder' } });
        expect(placed.status).toBe(201);
        const order = placed.body.content.order;
        await request(app).post('/api/v1/payments/fake/confirm')
            .send({ intent_ref: order.payment.intent_ref, outcome: 'authorized' });

        const ship = await request(app).post(`/api/v1/orders/${order.ord_no}/ship`)
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(ship.status).toBe(200);
        expect(ship.body.content.status).toBe('partially_shipped');

        const lines = await db.query(
            `SELECT id, fulfillment_status FROM order_lines WHERE _ord_no = $1 ORDER BY ln_no`, [order.ord_no]);
        const [shippedLn, backLn] = lines.rows;

        const good = await request(app).post('/api/v1/rmas')
            .set('Authorization', `Bearer ${token(user)}`)
            .send({ ord_no: order.ord_no, reason: 'x', lines: [{ order_line_id: shippedLn.id, qty: 1 }] });
        expect(good.status).toBe(201);

        const bad = await request(app).post('/api/v1/rmas')
            .set('Authorization', `Bearer ${token(user)}`)
            .send({ ord_no: order.ord_no, reason: 'x', lines: [{ order_line_id: backLn.id, qty: 1 }] });
        expect(bad.status).toBe(409);
        expect(bad.body.outcome.message).toMatch(/has not shipped/);
    });

    test('given the return window has passed then customers are refused but staff may still open one', async () => {
        const { user, order, line } = await shippedOrder('WINDOW');
        await db.query(
            `UPDATE order_status_history SET _create_ts = NOW() - INTERVAL '31 days' WHERE _ord_no = $1`,
            [order.ord_no]);

        const late = await request(app).post('/api/v1/rmas')
            .set('Authorization', `Bearer ${token(user)}`)
            .send({ ord_no: order.ord_no, reason: 'late', lines: [{ order_line_id: line.id, qty: 1 }] });
        expect(late.status).toBe(409);
        expect(late.body.outcome.message).toMatch(/return window/);

        // Staff (rma:manage) can override the window — it is policy, not integrity.
        const staff = await request(app).post('/api/v1/rmas')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ ord_no: order.ord_no, reason: 'goodwill exception', lines: [{ order_line_id: line.id, qty: 1 }] });
        expect(staff.status).toBe(201);
    });

    test('given no explicit amount then the refund is what the customer paid, discount prorated', async () => {
        // 10% promo: 2 × 15 = 30 subtotal, 3 discount → customer paid 27 for the goods.
        const code = `RMADEF-${RUN}`;
        await makePromo({ code, name: 'RMA default', promo_type: 'percent', value: 10 });
        const v = await makeVariant('REFDEF', 15);
        const user = await makeShopper('refdef', [{ variantNo: v, qty: 2 }]);
        const placed = await checkout(user, { promoCode: code });
        const order = placed.body.content.order;
        await request(app).post('/api/v1/payments/fake/confirm')
            .send({ intent_ref: order.payment.intent_ref, outcome: 'authorized' });
        await request(app).post(`/api/v1/orders/${order.ord_no}/ship`)
            .set('Authorization', `Bearer ${adminToken()}`);
        const line = (await db.query(
            `SELECT id FROM order_lines WHERE _ord_no = $1`, [order.ord_no])).rows[0];

        const req1 = await request(app).post('/api/v1/rmas')
            .set('Authorization', `Bearer ${token(user)}`)
            .send({ ord_no: order.ord_no, reason: 'full return', lines: [{ order_line_id: line.id, qty: 2 }] });
        const rmaNo = req1.body.content.rma_no;

        // The detail advertises the suggestion to Finance.
        const detail = await request(app).get(`/api/v1/rmas/${rmaNo}`)
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(Number(detail.body.content.rma.suggested_refund)).toBe(27);

        await request(app).put(`/api/v1/rmas/${rmaNo}/status`)
            .set('Authorization', `Bearer ${adminToken()}`).send({ status: 'approved' });
        const rmaLines = await db.query(`SELECT id FROM rma_lines WHERE _rma_no = $1`, [rmaNo]);
        await request(app).post(`/api/v1/rmas/${rmaNo}/receive`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ lines: [{ rma_line_id: rmaLines.rows[0].id, restock: true }] });

        const refund = await request(app).post(`/api/v1/rmas/${rmaNo}/refund`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({});   // no amount → policy default
        expect(refund.status).toBe(201);
        expect(Number(refund.body.content.amount)).toBe(27);

        const row = await db.query(`SELECT amount, status FROM refunds WHERE _ord_no = $1`, [order.ord_no]);
        expect(Number(row.rows[0].amount)).toBe(27);
        expect(row.rows[0].status).toBe('completed');
    });

    test('given a customer without rma:manage then staff endpoints are 403', async () => {
        const { user, order, line } = await shippedOrder('RMA5');
        const req1 = await request(app).post('/api/v1/rmas')
            .set('Authorization', `Bearer ${token(user)}`)
            .send({ ord_no: order.ord_no, reason: 'x', lines: [{ order_line_id: line.id, qty: 1 }] });
        const rmaNo = req1.body.content.rma_no;

        const res = await request(app).put(`/api/v1/rmas/${rmaNo}/status`)
            .set('Authorization', `Bearer ${token(user)}`).send({ status: 'approved' });
        expect(res.status).toBe(403);
    });
});

describe('given compliance requests when processed then export completes and delete stays manual', () => {

    test('given a gdpr_export then the job assembles the subject data payload', async () => {
        const { user, order } = await shippedOrder('GDPR1');
        const created = await ComplianceService.createRequest({ req_type: 'gdpr_export', email: user.email });
        const result  = await ComplianceService.process(created.id);
        expect(result.completed).toBe(true);

        const row = await db.query(`SELECT status, notes FROM compliance_requests WHERE id = $1`, [created.id]);
        expect(row.rows[0].status).toBe('completed');
        const payload = JSON.parse(row.rows[0].notes);
        expect(payload.subject_email).toBe(user.email);
        expect(payload.orders.map(o => Number(o.ord_no))).toContain(Number(order.ord_no));
    });

    test('given a gdpr_delete then the request is staged for manual anonymization (stub, flagged)', async () => {
        const { user } = await shippedOrder('GDPR2');
        const created = await ComplianceService.createRequest({ req_type: 'gdpr_delete', email: user.email });
        const result  = await ComplianceService.process(created.id);
        expect(result.staged).toBe(true);

        const row = await db.query(`SELECT status, notes FROM compliance_requests WHERE id = $1`, [created.id]);
        expect(row.rows[0].status).toBe('processing');
        expect(row.rows[0].notes).toMatch(/STUB/);
        expect(row.rows[0].notes).toMatch(/orders_to_retain_with_pii_scrub/);
    });

    test('given the API then customers file for their own email and cannot list the queue', async () => {
        const user = await makeShopper('gdpr3');
        const filed = await request(app).post('/api/v1/compliance/requests')
            .set('Authorization', `Bearer ${token(user)}`)
            .send({ req_type: 'gdpr_export', email: 'someone-else@example.com' });
        expect(filed.status).toBe(201);
        // non-staff: subject email is forced to their own
        expect(filed.body.content.request).toBeDefined();
        const row = await db.query(`SELECT email FROM compliance_requests WHERE id = $1`,
            [filed.body.content.request.id]);
        expect(row.rows[0].email).toBe(user.email);

        const list = await request(app).get('/api/v1/compliance/requests')
            .set('Authorization', `Bearer ${token(user)}`);
        expect(list.status).toBe(403);
    });
});
