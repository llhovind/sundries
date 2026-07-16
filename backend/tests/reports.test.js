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

// `day` (YYYY-MM-DD, optional) backdates the row to noon on that day —
// the ledger is append-only, so historic fixtures must be dated at insert.
async function makeOrderShell(email, day = null) {
    const cust = await db.query(
        `INSERT INTO customers (name, email, is_guest) VALUES ('Report Test', $1, TRUE) RETURNING id`,
        [email]);
    const ord = await db.query(
        `INSERT INTO orders (_customer_id, email, subtotal, total, status, placed_at)
         VALUES ($1, $2, 0, 0, 'paid',
                 COALESCE($3::date + interval '12 hours', NOW())) RETURNING ord_no`,
        [cust.rows[0].id, email, day]);
    return Number(ord.rows[0].ord_no);
}

async function sell(variantNo, qty, unitPrice, ordNo, day = null) {
    await db.query(
        `INSERT INTO inventory_transactions
            (_trn_type, _variant_no, _warehouse_no, qty, unit_price, _lnk_table, _lnk_id, _trn_dt)
         VALUES ('OUT', $1, $2, $3, $4, 'orders', $5,
                 COALESCE($6::date + interval '12 hours', NOW()))`,
        [variantNo, wh, -qty, unitPrice, ordNo, day]);
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

    // The rollup aggregates a whole calendar day, and parallel suites write
    // sales into "today" constantly — asserting against today is a race. This
    // test instead seeds a private HISTORIC day (derived from the run id, so
    // repeated runs land on different days) and asserts exact deltas between
    // rollups, which also makes it immune to leftovers from any prior run
    // that happened to hit the same day (the ledger is append-only).
    const PRIVATE_DAY = new Date(Date.UTC(1900, 0, 1) + (RUN % 30000) * 86400000)
        .toISOString().slice(0, 10);

    function factsFor(day) {
        return Reports.salesSummary({ from: day, to: day }).then(rows => rows[0]);
    }

    test('given a backdated day then the facts row moves by exactly the seeded ledger activity, idempotently', async () => {
        await Reports.rollupDay(PRIVATE_DAY);
        const before = await factsFor(PRIVATE_DAY);   // zeros row or prior-run leftovers

        // Private FIFO layer dated on the historic day: it is the oldest layer
        // for variant A, so the OUT and ADJ below consume exactly it —
        // 10 sold @ cost $4 (COGS 40), 2 written off @ $4 (shrinkage 8).
        const ordNo = await makeOrderShell(`rpt-roll-${RUN}@example.com`, PRIVATE_DAY);
        await db.query(
            `INSERT INTO inventory_transactions
                (_trn_type, _variant_no, _warehouse_no, qty, unit_cost, _trn_dt)
             VALUES ('IN', $1, $2, 12, 4, $3::date + interval '12 hours')`,
            [variantA, wh, PRIVATE_DAY]);
        await sell(variantA, 10, 7, ordNo, PRIVATE_DAY);
        await db.query(
            `INSERT INTO inventory_transactions
                (_trn_type, _variant_no, _warehouse_no, qty, reason_code, _trn_dt)
             VALUES ('ADJ', $1, $2, -2, $3, $4::date + interval '12 hours')`,
            [variantA, wh, `rollup-${RUN}`, PRIVATE_DAY]);

        await Reports.rollupDay(PRIVATE_DAY);
        const after = await factsFor(PRIVATE_DAY);

        expect(Number(after.orders_placed)  - Number(before.orders_placed)).toBe(1);
        expect(Number(after.units_sold)     - Number(before.units_sold)).toBe(10);
        expect(Number(after.revenue)        - Number(before.revenue)).toBe(70);     // 10 × $7
        expect(Number(after.cogs)           - Number(before.cogs)).toBe(40);        // 10 × $4
        expect(Number(after.shrinkage_cost) - Number(before.shrinkage_cost)).toBe(8); // 2 × $4
        expect(Number(after.gross_margin)).toBe(Number((after.revenue - after.cogs).toFixed(2)));

        // Idempotency: recomputing with an unchanged ledger changes nothing.
        await Reports.rollupDay(PRIVATE_DAY);
        expect(await factsFor(PRIVATE_DAY)).toEqual(after);
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
