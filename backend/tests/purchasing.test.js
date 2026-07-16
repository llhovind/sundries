'use strict';

/**
 * Purchasing integration tests: raising POs, receiving against them
 * (partial and full, with FIFO cost layers landing from the line's unit
 * cost), short-close, cancellation rules, and permission boundaries.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');

const RUN = Date.now();
let mainWh, vendorId, productNo;

function token(perms) {
    return jwt.sign(
        { sub: 1, email: 'staff@t.l', role: 'admin', roles: ['purchasing'], perms },
        process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }
    );
}
const purchasingAuth = () => `Bearer ${token(['purchasing:manage', 'inventory:read', 'inventory:receive'])}`;
const manageOnlyAuth = () => `Bearer ${token(['purchasing:manage'])}`;
const receiveOnlyAuth = () => `Bearer ${token(['inventory:receive'])}`;

async function makeVariant(tag) {
    const res = await db.query(
        `INSERT INTO product_variants (_product_no, sku, price) VALUES ($1, $2, 20) RETURNING variant_no`,
        [productNo, `PO-${RUN}-${tag}`]);
    return Number(res.rows[0].variant_no);
}

async function balance(variantNo) {
    const res = await db.query(
        `SELECT qty_on_hand FROM inventory_balances WHERE _variant_no = $1 AND _warehouse_no = $2`,
        [variantNo, mainWh]);
    return res.rows.length ? Number(res.rows[0].qty_on_hand) : 0;
}

async function raisePo(lines, extra = {}) {
    return request(app).post('/api/v1/purchase-orders')
        .set('Authorization', purchasingAuth())
        .send({ vendor_id: vendorId, warehouse_no: mainWh, lines, ...extra });
}

async function poDetail(poNo) {
    const res = await request(app).get(`/api/v1/purchase-orders/${poNo}`)
        .set('Authorization', purchasingAuth());
    return res.body.content.purchase_order;
}

beforeAll(async () => {
    mainWh = Number((await db.query(`SELECT warehouse_no FROM warehouses WHERE code = 'MAIN'`)).rows[0].warehouse_no);
    vendorId = Number((await db.query(
        `INSERT INTO vendors (name) VALUES ($1) RETURNING id`, [`PO Vendor ${RUN}`])).rows[0].id);
    productNo = Number((await db.query(
        `INSERT INTO products (name, status) VALUES ($1, 'active') RETURNING product_no`,
        [`PO Product ${RUN}`])).rows[0].product_no);
});

afterAll(async () => {
    await pool.end();
});

describe('given the purchasing API when callers lack permissions then access is denied', () => {

    test('given inventory:receive only then raising a PO is 403; given purchasing:manage only then receiving is 403', async () => {
        const v = await makeVariant('PERM');

        const raise = await request(app).post('/api/v1/purchase-orders')
            .set('Authorization', receiveOnlyAuth())
            .send({ vendor_id: vendorId, warehouse_no: mainWh, lines: [{ variant_no: v, qty: 1, unit_cost: 1 }] });
        expect(raise.status).toBe(403);

        const created = await raisePo([{ variant_no: v, qty: 2, unit_cost: 1 }]);
        expect(created.status).toBe(201);
        const receive = await request(app)
            .post(`/api/v1/purchase-orders/${created.body.content.po_no}/receive`)
            .set('Authorization', manageOnlyAuth())
            .send({ lines: [] });
        expect(receive.status).toBe(403);
    });
});

describe('given a raised PO when received then stock and cost layers land from the document', () => {

    test('given partial then full receipts then the PO advances open → received and the ledger links back', async () => {
        const v1 = await makeVariant('A');
        const v2 = await makeVariant('B');

        const created = await raisePo(
            [{ variant_no: v1, qty: 10, unit_cost: 2.5 }, { variant_no: v2, qty: 4, unit_cost: 7 }],
            { vendor_ordno: `VO-${RUN}`, freight: 45 });
        expect(created.status).toBe(201);
        const poNo = created.body.content.po_no;

        let po = await poDetail(poNo);
        expect(po.po_status).toBe('open');
        expect(Number(po.subtotal)).toBe(53);   // 10×2.50 + 4×7.00
        const [lnA, lnB] = po.lines;

        // Partial receipt on line A only — PO stays open.
        const partial = await request(app).post(`/api/v1/purchase-orders/${poNo}/receive`)
            .set('Authorization', purchasingAuth())
            .send({ lines: [{ po_line_id: lnA.id, qty: 6 }] });
        expect(partial.status).toBe(200);
        expect(partial.body.content.po_status).toBe('open');
        expect(await balance(v1)).toBe(6);

        const trn = await db.query(
            `SELECT _trn_type, qty, unit_cost, _ln_no FROM inventory_transactions
             WHERE _lnk_table = 'purchaseorders' AND _lnk_id = $1`, [poNo]);
        expect(trn.rows).toHaveLength(1);
        expect(trn.rows[0]).toMatchObject({ _trn_type: 'IN', _ln_no: 1 });
        expect(Number(trn.rows[0].unit_cost)).toBe(2.5);   // line cost seeds the FIFO layer

        // Remainder of A + all of B — every line full → 'received'.
        const rest = await request(app).post(`/api/v1/purchase-orders/${poNo}/receive`)
            .set('Authorization', purchasingAuth())
            .send({ lines: [{ po_line_id: lnA.id, qty: 4 }, { po_line_id: lnB.id, qty: 4 }] });
        expect(rest.status).toBe(200);
        expect(rest.body.content.po_status).toBe('received');
        expect(await balance(v1)).toBe(10);
        expect(await balance(v2)).toBe(4);

        po = await poDetail(poNo);
        expect(Number(po.lines[0].qty_received)).toBe(10);

        // Receiving against a received PO is a clean 409.
        const late = await request(app).post(`/api/v1/purchase-orders/${poNo}/receive`)
            .set('Authorization', purchasingAuth())
            .send({ lines: [{ po_line_id: lnA.id, qty: 1 }] });
        expect(late.status).toBe(409);

        // Normal completion: close the received PO.
        const closed = await request(app).post(`/api/v1/purchase-orders/${poNo}/close`)
            .set('Authorization', purchasingAuth());
        expect(closed.status).toBe(200);
    });

    test('given a receipt beyond the line remainder then 409 and nothing moves', async () => {
        const v = await makeVariant('OVER');
        const created = await raisePo([{ variant_no: v, qty: 5, unit_cost: 3 }]);
        const poNo = created.body.content.po_no;
        const line = (await poDetail(poNo)).lines[0];

        const res = await request(app).post(`/api/v1/purchase-orders/${poNo}/receive`)
            .set('Authorization', purchasingAuth())
            .send({ lines: [{ po_line_id: line.id, qty: 8 }] });
        expect(res.status).toBe(409);
        expect(res.body.outcome.message).toMatch(/exceeds the remaining/);
        expect(await balance(v)).toBe(0);
    });

    test('given an open PO with partial receipts then it short-closes but cannot cancel', async () => {
        const v = await makeVariant('SHORT');
        const created = await raisePo([{ variant_no: v, qty: 6, unit_cost: 1 }]);
        const poNo = created.body.content.po_no;
        const line = (await poDetail(poNo)).lines[0];

        await request(app).post(`/api/v1/purchase-orders/${poNo}/receive`)
            .set('Authorization', purchasingAuth())
            .send({ lines: [{ po_line_id: line.id, qty: 2 }] });

        const cancel = await request(app).post(`/api/v1/purchase-orders/${poNo}/cancel`)
            .set('Authorization', purchasingAuth());
        expect(cancel.status).toBe(409);
        expect(cancel.body.outcome.message).toMatch(/close it instead/);

        const closed = await request(app).post(`/api/v1/purchase-orders/${poNo}/close`)
            .set('Authorization', purchasingAuth());
        expect(closed.status).toBe(200);

        // Short-closed: the outstanding 4 never arrive, receiving is over.
        const late = await request(app).post(`/api/v1/purchase-orders/${poNo}/receive`)
            .set('Authorization', purchasingAuth())
            .send({ lines: [{ po_line_id: line.id, qty: 4 }] });
        expect(late.status).toBe(409);
        expect(await balance(v)).toBe(2);
    });

    test('given an untouched open PO then cancel works; invalid creates are rejected', async () => {
        const v = await makeVariant('CXL');
        const created = await raisePo([{ variant_no: v, qty: 3, unit_cost: 2 }]);
        const cancel = await request(app).post(`/api/v1/purchase-orders/${created.body.content.po_no}/cancel`)
            .set('Authorization', purchasingAuth());
        expect(cancel.status).toBe(200);

        expect((await raisePo([])).status).toBe(400);                                        // no lines
        expect((await raisePo([{ variant_no: v, qty: 0, unit_cost: 1 }])).status).toBe(400); // bad qty
        expect((await raisePo([{ variant_no: v, qty: 1, unit_cost: 1 }], { vendor_id: 999999999 })).status).toBe(400);
    });
});

describe('given the PO list when filtered then status and totals read correctly', () => {

    test('given ?status=open then only open POs return, with ordered/received rollups', async () => {
        const v = await makeVariant('LIST');
        await raisePo([{ variant_no: v, qty: 9, unit_cost: 1 }]);

        const res = await request(app).get('/api/v1/purchase-orders?status=open&pageSize=100')
            .set('Authorization', purchasingAuth());
        expect(res.status).toBe(200);
        const rows = res.body.content.purchase_orders;
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows.every(r => r.po_status === 'open')).toBe(true);
        const mine = rows.find(r => r.vendor_name === `PO Vendor ${RUN}` && Number(r.qty_ordered) === 9);
        expect(mine).toBeTruthy();
        expect(Number(mine.qty_received)).toBe(0);
    });
});
