'use strict';

/**
 * Stock transfer API integration tests: permissions, draft creation,
 * dispatch → transport → receive with FIFO cost carried, oversell guard,
 * and cancellation rules. Runs against the real database and Express app.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');

const RUN = Date.now();
let mainWh, transitWh, destWh, productNo;

function token(perms) {
    return jwt.sign(
        { sub: 1, email: 'staff@t.l', role: 'admin', roles: ['inventory_control'], perms },
        process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }
    );
}
const transferAuth = () => `Bearer ${token(['inventory:read', 'inventory:transfer'])}`;
const readAuth     = () => `Bearer ${token(['inventory:read'])}`;

async function makeStockedVariant(tag, qty, unitCost = 4) {
    const res = await db.query(
        `INSERT INTO product_variants (_product_no, sku, price) VALUES ($1, $2, 10) RETURNING variant_no`,
        [productNo, `XFER-${RUN}-${tag}`]);
    const v = Number(res.rows[0].variant_no);
    if (qty > 0) {
        await db.query(
            `INSERT INTO inventory_transactions (_trn_type, _variant_no, _warehouse_no, qty, unit_cost)
             VALUES ('IN', $1, $2, $3, $4)`, [v, mainWh, qty, unitCost]);
    }
    return v;
}

async function balance(variantNo, warehouseNo) {
    const res = await db.query(
        `SELECT qty_on_hand FROM inventory_balances WHERE _variant_no = $1 AND _warehouse_no = $2`,
        [variantNo, warehouseNo]);
    return res.rows.length ? Number(res.rows[0].qty_on_hand) : 0;
}

async function createDraft(lines, extra = {}) {
    return request(app).post('/api/v1/inventory/transfers')
        .set('Authorization', transferAuth())
        .send({
            from_warehouse_no: mainWh, to_warehouse_no: destWh, transport_warehouse_no: transitWh,
            carrier: 'TestFreight', tracking_no: `TRK-${RUN}`, lines, ...extra,
        });
}

beforeAll(async () => {
    mainWh    = Number((await db.query(`SELECT warehouse_no FROM warehouses WHERE code = 'MAIN'`)).rows[0].warehouse_no);
    transitWh = Number((await db.query(`SELECT warehouse_no FROM warehouses WHERE code = 'TRANSIT'`)).rows[0].warehouse_no);
    destWh    = Number((await db.query(
        `INSERT INTO warehouses (code, name, wh_type, priority) VALUES ($1, 'Second WH', 'standard', 50)
         RETURNING warehouse_no`, [`WH2-${RUN}`])).rows[0].warehouse_no);
    productNo = Number((await db.query(
        `INSERT INTO products (name, status) VALUES ($1, 'active') RETURNING product_no`,
        [`Transfer Product ${RUN}`])).rows[0].product_no);
});

afterAll(async () => {
    // Keep allocation deterministic for other suites sharing this database:
    // the extra warehouse must not attract future reservations.
    await db.query(`UPDATE warehouses SET status = 'inactive' WHERE warehouse_no = $1`, [destWh]);
    await pool.end();
});

describe('given the transfer API when callers lack permissions then access is denied', () => {

    test('given inventory:read only then reads work and lifecycle calls are 403', async () => {
        const list = await request(app).get('/api/v1/inventory/transfers').set('Authorization', readAuth());
        expect(list.status).toBe(200);

        const create = await request(app).post('/api/v1/inventory/transfers')
            .set('Authorization', readAuth()).send({});
        expect(create.status).toBe(403);
    });

    test('given no token then 401', async () => {
        const res = await request(app).get('/api/v1/inventory/transfers');
        expect(res.status).toBe(401);
    });
});

describe('given a draft transfer when dispatched and received then stock moves at its FIFO cost', () => {

    test('given the full lifecycle then balances and ledger track origin → transit → destination', async () => {
        const v = await makeStockedVariant('FULL', 10, 4);

        const created = await createDraft([{ variant_no: v, qty: 6 }], { manifest_id: 'M-1', notes: 'restock run' });
        expect(created.status).toBe(201);
        const transferNo = created.body.content.transfer_no;

        // Draft: nothing has moved yet.
        expect(await balance(v, mainWh)).toBe(10);

        const detail = await request(app).get(`/api/v1/inventory/transfers/${transferNo}`)
            .set('Authorization', readAuth());
        expect(detail.status).toBe(200);
        expect(detail.body.content.transfer.status).toBe('draft');
        expect(detail.body.content.transfer.lines).toEqual([
            expect.objectContaining({ _variant_no: String(v), qty: 6 }),
        ]);

        // Dispatch: origin −6, transit +6, cost travels with the goods.
        const dispatched = await request(app).post(`/api/v1/inventory/transfers/${transferNo}/dispatch`)
            .set('Authorization', transferAuth());
        expect(dispatched.status).toBe(200);
        expect(await balance(v, mainWh)).toBe(4);
        expect(await balance(v, transitWh)).toBe(6);

        const legs = await db.query(
            `SELECT _trn_type, _warehouse_no, qty, unit_cost FROM inventory_transactions
             WHERE _lnk_table = 'stock_transfers' AND _lnk_id = $1 ORDER BY trn_no`, [transferNo]);
        expect(legs.rows.map(r => r._trn_type)).toEqual(['XFER_OUT', 'XFER_IN']);
        expect(legs.rows.every(r => Number(r.unit_cost) === 4)).toBe(true);

        // Receive: transit −6, destination +6, still at cost 4.
        const received = await request(app).post(`/api/v1/inventory/transfers/${transferNo}/receive`)
            .set('Authorization', transferAuth());
        expect(received.status).toBe(200);
        expect(await balance(v, transitWh)).toBe(0);
        expect(await balance(v, destWh)).toBe(6);

        const destLayer = await db.query(
            `SELECT unit_cost, qty_remaining FROM inventory_cost_layers
             WHERE _variant_no = $1 AND _warehouse_no = $2`, [v, destWh]);
        expect(Number(destLayer.rows[0].unit_cost)).toBe(4);
        expect(Number(destLayer.rows[0].qty_remaining)).toBe(6);

        // Terminal: re-dispatch / re-receive / cancel are all clean 4xx no-ops.
        const again = await request(app).post(`/api/v1/inventory/transfers/${transferNo}/receive`)
            .set('Authorization', transferAuth());
        expect(again.status).toBe(409);
        const cancel = await request(app).post(`/api/v1/inventory/transfers/${transferNo}/cancel`)
            .set('Authorization', transferAuth());
        expect(cancel.status).toBe(409);
    });

    test('given more qty than the origin holds then dispatch fails and nothing moves', async () => {
        const v = await makeStockedVariant('OVER', 3);
        const created = await createDraft([{ variant_no: v, qty: 8 }]);
        expect(created.status).toBe(201);
        const transferNo = created.body.content.transfer_no;

        const res = await request(app).post(`/api/v1/inventory/transfers/${transferNo}/dispatch`)
            .set('Authorization', transferAuth());
        expect(res.status).toBe(400);

        expect(await balance(v, mainWh)).toBe(3);
        expect(await balance(v, transitWh)).toBe(0);
        const row = await db.query(`SELECT status FROM stock_transfers WHERE transfer_no = $1`, [transferNo]);
        expect(row.rows[0].status).toBe('draft');   // transaction rolled back whole
    });

    test('given a draft then cancel works and moves no stock', async () => {
        const v = await makeStockedVariant('CXL', 5);
        const created = await createDraft([{ variant_no: v, qty: 2 }]);
        const transferNo = created.body.content.transfer_no;

        const res = await request(app).post(`/api/v1/inventory/transfers/${transferNo}/cancel`)
            .set('Authorization', transferAuth());
        expect(res.status).toBe(200);
        expect(res.body.content.status).toBe('cancelled');
        expect(await balance(v, mainWh)).toBe(5);
    });

    test('given invalid shapes then creation is rejected', async () => {
        const v = await makeStockedVariant('BAD', 1);

        const sameEndpoints = await createDraft([{ variant_no: v, qty: 1 }], { to_warehouse_no: mainWh });
        expect(sameEndpoints.status).toBe(400);

        const noLines = await createDraft([]);
        expect(noLines.status).toBe(400);

        const wrongTransport = await createDraft([{ variant_no: v, qty: 1 }], { transport_warehouse_no: destWh });
        expect(wrongTransport.status).toBe(400);
    });
});

describe('given the transfer list when filtered by status then only matching rows return', () => {

    test('given ?status=draft then received/cancelled transfers are excluded', async () => {
        const v = await makeStockedVariant('LIST', 5);
        await createDraft([{ variant_no: v, qty: 1 }]);

        const res = await request(app).get('/api/v1/inventory/transfers?status=draft&pageSize=100')
            .set('Authorization', readAuth());
        expect(res.status).toBe(200);
        expect(res.body.content.transfers.length).toBeGreaterThanOrEqual(1);
        expect(res.body.content.transfers.every(t => t.status === 'draft')).toBe(true);
    });
});
