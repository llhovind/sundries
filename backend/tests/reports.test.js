'use strict';

/**
 * Phase 6 reporting tests. A dedicated warehouse isolates valuation math;
 * COGS assertions key off uniquely-named products so parallel suites and
 * prior runs can't pollute the numbers.
 *
 * Scenario (variant A): receive 10 @ $2 then 10 @ $3, sell 12 @ $8
 *   → FIFO COGS = 10×2 + 2×3 = $26, revenue $96, margin $70
 *   then write off 3 as remnants → 3 × $3 = $9 shrinkage
 *   → remaining value = 5 × $3 = $15
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');
const Reports          = require('../models/reports');
const InventoryService = require('../services/inventoryService');

const RUN   = Date.now();
const TODAY = new Date().toISOString().slice(0, 10);

let wh, catId, productA, productB, variantA, variantB;

function token(perms, roles = ['finance']) {
    return jwt.sign(
        { sub: 1, email: 'rpt@test.local', role: 'finance', roles, perms },
        process.env.JWT_ACCESS_SECRET, { expiresIn: '5m' }
    );
}

async function makeOrderShell(email) {
    const cust = await db.query(
        `INSERT INTO customers (name, email, is_guest) VALUES ('Report Test', $1, TRUE) RETURNING id`,
        [email]);
    const ord = await db.query(
        `INSERT INTO orders (_customer_id, email, subtotal, total, status)
         VALUES ($1, $2, 0, 0, 'paid') RETURNING ord_no`,
        [cust.rows[0].id, email]);
    return Number(ord.rows[0].ord_no);
}

async function sell(variantNo, qty, unitPrice, ordNo) {
    await db.query(
        `INSERT INTO inventory_transactions
            (_trn_type, _variant_no, _warehouse_no, qty, unit_price, _lnk_table, _lnk_id)
         VALUES ('OUT', $1, $2, $3, $4, 'orders', $5)`,
        [variantNo, wh, -qty, unitPrice, ordNo]);
}

beforeAll(async () => {
    wh = Number((await db.query(
        `INSERT INTO warehouses (code, name, wh_type, priority)
         VALUES ($1, 'Reports WH', 'standard', 500) RETURNING warehouse_no`,
        [`RPT-${RUN}`])).rows[0].warehouse_no);

    catId = Number((await db.query(
        `INSERT INTO categories (name) VALUES ($1) RETURNING id`,
        [`ReportCat ${RUN}`])).rows[0].id);

    async function makeProduct(name, withCat) {
        const p = Number((await db.query(
            `INSERT INTO products (name, status) VALUES ($1, 'active') RETURNING product_no`,
            [name])).rows[0].product_no);
        if (withCat) {
            await db.query(`INSERT INTO product_categories (_product_no, _category_id) VALUES ($1, $2)`, [p, catId]);
        }
        const v = Number((await db.query(
            `INSERT INTO product_variants (_product_no, sku, price) VALUES ($1, $2, 10) RETURNING variant_no`,
            [p, `RPT-${RUN}-${name.slice(0, 4)}`])).rows[0].variant_no);
        return { p, v };
    }

    ({ p: productA, v: variantA } = await makeProduct(`Alpha Report ${RUN}`, true));
    ({ p: productB, v: variantB } = await makeProduct(`Beta Report ${RUN}`, false));

    // Receipts: A gets two cost layers, B one.
    await InventoryService.receiveStock({ variantNo: variantA, warehouseNo: wh, qty: 10, unitCost: 2 }, 1);
    await InventoryService.receiveStock({ variantNo: variantA, warehouseNo: wh, qty: 10, unitCost: 3 }, 1);
    await InventoryService.receiveStock({ variantNo: variantB, warehouseNo: wh, qty: 5,  unitCost: 10 }, 1);

    // Sales
    const ord1 = await makeOrderShell(`rpt-a-${RUN}@example.com`);
    const ord2 = await makeOrderShell(`rpt-b-${RUN}@example.com`);
    await sell(variantA, 12, 8, ord1);    // FIFO: 10@2 + 2@3 = 26
    await sell(variantB, 2, 20, ord2);    // 2@10 = 20

    // Remnant write-off on A: 3 @ remaining layer cost $3
    await InventoryService.writeOff(
        { variantNo: variantA, warehouseNo: wh, qty: 3, reasonCode: `remnant-${RUN}` }, 1);
});

afterAll(async () => {
    await pool.end();
});

describe('given ledger activity when COGS is reported then FIFO figures come straight off the ledger', () => {

    test('given group_by=product then units, revenue, COGS and margin are exact', async () => {
        const rows = await Reports.cogs({ from: TODAY, to: TODAY, groupBy: 'product' });

        const a = rows.find(r => r.group_label === `Alpha Report ${RUN}`);
        expect(a).toBeDefined();
        expect(Number(a.units_sold)).toBe(12);
        expect(Number(a.revenue)).toBe(96);
        expect(Number(a.cogs)).toBe(26);          // 10×2 + 2×3 — blended FIFO
        expect(Number(a.gross_margin)).toBe(70);

        const b = rows.find(r => r.group_label === `Beta Report ${RUN}`);
        expect(Number(b.cogs)).toBe(20);
        expect(Number(b.revenue)).toBe(40);
    });

    test('given group_by=category then categorized and uncategorized products split correctly', async () => {
        const rows = await Reports.cogs({ from: TODAY, to: TODAY, groupBy: 'category' });
        const cat = rows.find(r => r.group_label === `ReportCat ${RUN}`);
        expect(Number(cat.cogs)).toBe(26);        // only product A is in the category

        const uncat = rows.find(r => r.group_label === 'Uncategorized');
        expect(uncat).toBeDefined();              // product B lands here (with others)
        expect(Number(uncat.cogs)).toBeGreaterThanOrEqual(20);
    });

    test('given an invalid group_by then the report rejects with 400', async () => {
        await expect(Reports.cogs({ from: TODAY, to: TODAY, groupBy: 'vibes' }))
            .rejects.toMatchObject({ status: 400 });
    });
});

describe('given remaining FIFO layers when valuation runs then on-hand value is exact per warehouse', () => {

    test('given the isolated warehouse then value = Σ(qty_remaining × layer cost)', async () => {
        const rows = await Reports.valuation({ warehouseNo: wh });
        expect(rows).toHaveLength(1);
        const v = rows[0];
        expect(v.in_transit).toBe(false);
        expect(Number(v.units_on_hand)).toBe(5 + 3);        // A: 5 left, B: 3 left
        expect(Number(v.value)).toBe(5 * 3 + 3 * 10);       // 15 + 30 = 45
    });
});

describe('given write-offs when shrinkage is reported then cost groups by reason', () => {

    test('given the remnant write-off then its cost is 3 × $3 under its reason code', async () => {
        const rows = await Reports.shrinkage({ from: TODAY, to: TODAY });
        const remnant = rows.find(r => r.reason === `remnant-${RUN}`);
        expect(remnant).toBeDefined();
        expect(Number(remnant.units)).toBe(3);
        expect(Number(remnant.cost)).toBe(9);
    });
});

describe('given active checkouts when reservations are reported then held stock is visible', () => {

    test('given a live reservation then it appears with sku and expiry', async () => {
        const ordNo = await makeOrderShell(`rpt-res-${RUN}@example.com`);
        await InventoryService.reserveForOrder(ordNo, [{ variantNo: variantB, qty: 1 }], 1);

        const rows = await Reports.reservations();
        const mine = rows.find(r => Number(r._ord_no) === ordNo);
        expect(mine).toBeDefined();
        expect(Number(mine.qty)).toBe(1);
        expect(mine.sku).toContain(`RPT-${RUN}`);
    });
});

describe('given the nightly rollup when recomputed then the summary reflects the ledger', () => {

    test('given rollupDay(today) then the facts row carries our revenue/cogs and is idempotent', async () => {
        await Reports.rollupDay(TODAY);
        const first = await Reports.salesSummary({ from: TODAY, to: TODAY });
        expect(first).toHaveLength(1);
        const row = first[0];
        expect(Number(row.revenue)).toBeGreaterThanOrEqual(96 + 40);
        expect(Number(row.cogs)).toBeGreaterThanOrEqual(26 + 20);
        expect(Number(row.shrinkage_cost)).toBeGreaterThanOrEqual(9);
        expect(Number(row.gross_margin)).toBe(Number((row.revenue - row.cogs).toFixed(2)));

        await Reports.rollupDay(TODAY);   // idempotent recompute
        const second = await Reports.salesSummary({ from: TODAY, to: TODAY });
        expect(Number(second[0].revenue)).toBe(Number(row.revenue));
    });
});

describe('given the report routes when called then permissions gate cost data', () => {

    test('given reports:cogs (finance) then COGS returns 200 through the API', async () => {
        const res = await request(app)
            .get(`/api/v1/reports/cogs?from=${TODAY}&to=${TODAY}&group_by=product`)
            .set('Authorization', `Bearer ${token(['reports:cogs', 'reports:view'])}`);
        expect(res.status).toBe(200);
        expect(res.body.content.cogs.length).toBeGreaterThanOrEqual(2);
    });

    test('given only reports:view (fulfillment) then COGS is 403 but sales-summary is 200', async () => {
        const viewOnly = token(['reports:view'], ['fulfillment']);
        const cogsRes = await request(app)
            .get(`/api/v1/reports/cogs`).set('Authorization', `Bearer ${viewOnly}`);
        expect(cogsRes.status).toBe(403);

        const sumRes = await request(app)
            .get(`/api/v1/reports/sales-summary`).set('Authorization', `Bearer ${viewOnly}`);
        expect(sumRes.status).toBe(200);
    });

    test('given a customer (no report permissions) then every report is 403', async () => {
        const cust = token([], ['customer']);
        for (const path of ['cogs', 'valuation', 'shrinkage', 'reservations', 'sales-summary']) {
            const res = await request(app)
                .get(`/api/v1/reports/${path}`).set('Authorization', `Bearer ${cust}`);
            expect(res.status).toBe(403);
        }
    });
});
