'use strict';

/**
 * Reporting system tests. A dedicated warehouse isolates valuation math;
 * COGS assertions key off uniquely-named products so parallel suites and
 * prior runs can't pollute the numbers.
 *
 * Scenario (variant A): receive 10 @ $2 then 10 @ $3, sell 12 @ $8
 *   → FIFO COGS = 10×2 + 2×3 = $26, revenue $96, margin $70
 *   then write off 3 as remnants → 3 × $3 = $9 shrinkage
 *   → remaining value = 5 × $3 = $15
 *
 * Covers: registry-driven report execution, category-scoped permissions
 * (catalog filtering + per-slug 403s), stored-run lifecycle (queue → claim →
 * execute → snapshot), the subprocess path end-to-end, and CSV download.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');
const Reports          = require('../models/reports');
const registry         = require('../services/reporting/registry');
const RunService       = require('../services/reporting/runService');
const ReportRuns       = require('../models/reportRuns');
const InventoryService = require('../services/inventoryService');

const RUN   = Date.now();
const TODAY = new Date().toISOString().slice(0, 10);

const ALL_REPORT_PERMS = ['reports:sales', 'reports:finance', 'reports:inventory', 'reports:purchasing'];

let wh, catId, productA, productB, variantA, variantB, staffId;

function token(perms, roles = ['finance'], sub = staffId) {
    return jwt.sign(
        { sub, email: 'rpt@test.local', role: 'finance', roles, perms },
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
    // A real user row: stored runs FK requested_by → users(id).
    staffId = Number((await db.query(
        `INSERT INTO users (username, email, role) VALUES ($1, $2, 'finance') RETURNING id`,
        [`rpt-staff-${RUN}`, `rpt-staff-${RUN}@test.local`])).rows[0].id);

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

describe('given the report registry when loaded then every report is discovered and categorized', () => {

    test('given the shipped report set then slugs, categories, and modes are as declared', () => {
        const bySlug = Object.fromEntries(registry.list().map(d => [d.slug, d]));
        expect(bySlug['sales-summary']).toMatchObject({ category: 'sales',      mode: 'immediate' });
        expect(bySlug['monthly-sales']).toMatchObject({ category: 'sales',      mode: 'stored' });
        expect(bySlug['cogs']).toMatchObject({          category: 'finance',    mode: 'immediate' });
        expect(bySlug['valuation']).toMatchObject({     category: 'finance',    mode: 'immediate' });
        expect(bySlug['shrinkage']).toMatchObject({     category: 'finance',    mode: 'immediate' });
        expect(bySlug['reservations']).toMatchObject({  category: 'inventory',  mode: 'immediate' });
        expect(bySlug['inventory-movements']).toMatchObject({ category: 'inventory', mode: 'stored' });
        expect(bySlug['open-purchase-orders']).toMatchObject({ category: 'purchasing', mode: 'immediate' });
        expect(registry.permissionFor(bySlug['cogs'])).toBe('reports:finance');
        expect(registry.scheduled().map(d => d.slug)).toContain('monthly-sales');
    });
});

describe('given broken report files when the registry loads then they are skipped, never fatal', () => {

    const fs   = require('fs');
    const path = require('path');
    const REPORTS_DIR = path.join(__dirname, '../controllers/reports');
    const SYNTAX_BAD  = path.join(REPORTS_DIR, 'zz-syntax-broken.js');
    const SHAPE_BAD   = path.join(REPORTS_DIR, 'zz-shape-broken.js');

    afterAll(() => {
        fs.rmSync(SYNTAX_BAD, { force: true });
        fs.rmSync(SHAPE_BAD,  { force: true });
    });

    test('given a file that will not parse and one that fails validation then both are logged and the rest still serve', () => {
        fs.writeFileSync(SYNTAX_BAD, 'this is not javascript {{{\n');
        fs.writeFileSync(SHAPE_BAD,
            "module.exports = { slug: 'zz-shape-broken', name: 'Broken', descr: 'x', " +
            "category: 'no-such-category', mode: 'immediate', params: [], " +
            "columns: [{ key: 'a', label: 'A' }], run: async () => [] };\n");

        const logged = [];
        const realWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = (chunk, ...rest) => { logged.push(String(chunk)); return realWrite(chunk, ...rest); };

        let freshRegistry;
        try {
            jest.isolateModules(() => {
                freshRegistry = require('../services/reporting/registry');
            });
        } finally {
            process.stdout.write = realWrite;
        }

        // Both broken files skipped; every shipped report still registered.
        expect(freshRegistry.get('zz-syntax-broken')).toBeNull();
        expect(freshRegistry.get('zz-shape-broken')).toBeNull();
        expect(freshRegistry.list().map(d => d.slug))
            .toEqual(expect.arrayContaining(['cogs', 'sales-summary', 'inventory-movements', 'open-purchase-orders']));

        // Each skip is a structured error naming the file.
        const errors = logged.filter(l => l.includes('report definition skipped'));
        expect(errors.some(l => l.includes('zz-syntax-broken.js'))).toBe(true);
        expect(errors.some(l => l.includes('zz-shape-broken.js') && l.includes('no-such-category'))).toBe(true);
    });
});

describe('given ledger activity when COGS is reported then FIFO figures come straight off the ledger', () => {

    test('given group_by=product then units, revenue, COGS and margin are exact', async () => {
        const rows = await registry.get('cogs').run({ from: TODAY, to: TODAY, group_by: 'product' });

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
        const rows = await registry.get('cogs').run({ from: TODAY, to: TODAY, group_by: 'category' });
        const cat = rows.find(r => r.group_label === `ReportCat ${RUN}`);
        expect(Number(cat.cogs)).toBe(26);        // only product A is in the category

        const uncat = rows.find(r => r.group_label === 'Uncategorized');
        expect(uncat).toBeDefined();              // product B lands here (with others)
        expect(Number(uncat.cogs)).toBeGreaterThanOrEqual(20);
    });

    test('given an invalid group_by then the API rejects with 400 before the report runs', async () => {
        const res = await request(app)
            .get(`/api/v1/reports/cogs/results?group_by=vibes`)
            .set('Authorization', `Bearer ${token(['reports:finance'])}`);
        expect(res.status).toBe(400);
        expect(res.body.outcome.message).toMatch(/group_by/);
    });

    test('given a malformed date then the API rejects with 400', async () => {
        const res = await request(app)
            .get(`/api/v1/reports/cogs/results?from=2026-13-99`)
            .set('Authorization', `Bearer ${token(['reports:finance'])}`);
        expect(res.status).toBe(400);
    });
});

describe('given remaining FIFO layers when valuation runs then on-hand value is exact per warehouse', () => {

    test('given the isolated warehouse then value = Σ(qty_remaining × layer cost)', async () => {
        const rows = await registry.get('valuation').run({ warehouse_no: wh });
        expect(rows).toHaveLength(1);
        const v = rows[0];
        expect(v.in_transit).toBe(false);
        expect(Number(v.units_on_hand)).toBe(5 + 3);        // A: 5 left, B: 3 left
        expect(Number(v.value)).toBe(5 * 3 + 3 * 10);       // 15 + 30 = 45
    });
});

describe('given write-offs when shrinkage is reported then cost groups by reason', () => {

    test('given the remnant write-off then its cost is 3 × $3 under its reason code', async () => {
        const rows = await registry.get('shrinkage').run({ from: TODAY, to: TODAY });
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

        const rows = await registry.get('reservations').run({});
        const mine = rows.find(r => Number(r.ord_no) === ordNo);
        expect(mine).toBeDefined();
        expect(Number(mine.qty)).toBe(1);
        expect(mine.sku).toContain(`RPT-${RUN}`);
    });
});

describe('given the nightly rollup when recomputed then the facts reflect the ledger', () => {

    // The rollup aggregates a whole calendar day, and parallel suites write
    // sales into "today" constantly — asserting against today is a race. This
    // test instead seeds a private HISTORIC day (derived from the run id, so
    // repeated runs land on different days) and asserts exact deltas between
    // rollups, which also makes it immune to leftovers from any prior run
    // that happened to hit the same day (the ledger is append-only).
    const PRIVATE_DAY = new Date(Date.UTC(1900, 0, 1) + (RUN % 30000) * 86400000)
        .toISOString().slice(0, 10);

    function factsFor(day) {
        return db.query(
            `SELECT fact_date, orders_placed, units_sold, revenue, cogs, shrinkage_cost
             FROM daily_sales_facts WHERE fact_date = $1::date`, [day]
        ).then(res => res.rows[0]);
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

        // Idempotency: recomputing with an unchanged ledger changes nothing.
        await Reports.rollupDay(PRIVATE_DAY);
        expect(await factsFor(PRIVATE_DAY)).toEqual(after);

        // The sales-summary report reads these facts (revenue side only).
        const rows = await registry.get('sales-summary').run({ from: PRIVATE_DAY, to: PRIVATE_DAY });
        expect(Number(rows[0].revenue)).toBe(Number(after.revenue));
        expect(rows[0].cogs).toBeUndefined();
    });
});

describe('given category-scoped permissions when reports are called then access follows the category', () => {

    test('given all report permissions (finance) then COGS returns 200 through the API', async () => {
        const res = await request(app)
            .get(`/api/v1/reports/cogs/results?from=${TODAY}&to=${TODAY}&group_by=product`)
            .set('Authorization', `Bearer ${token(ALL_REPORT_PERMS)}`);
        expect(res.status).toBe(200);
        expect(res.body.content.rows.length).toBeGreaterThanOrEqual(2);
        expect(res.body.content.columns.map(c => c.key)).toContain('gross_margin');
    });

    test('given only reports:inventory (inventory control) then stock reports work but sales/finance are 403', async () => {
        const invOnly = token(['reports:inventory'], ['inventory_control']);

        expect((await request(app).get('/api/v1/reports/reservations/results')
            .set('Authorization', `Bearer ${invOnly}`)).status).toBe(200);

        // Inventory Control can't see what customers purchased, nor costs.
        expect((await request(app).get('/api/v1/reports/sales-summary/results')
            .set('Authorization', `Bearer ${invOnly}`)).status).toBe(403);
        expect((await request(app).get('/api/v1/reports/cogs/results')
            .set('Authorization', `Bearer ${invOnly}`)).status).toBe(403);
    });

    test('given only reports:sales (customer service) then sales work but purchasing is 403', async () => {
        const salesOnly = token(['reports:sales'], ['customer_service']);

        expect((await request(app).get('/api/v1/reports/sales-summary/results')
            .set('Authorization', `Bearer ${salesOnly}`)).status).toBe(200);
        expect((await request(app).get('/api/v1/reports/open-purchase-orders/results')
            .set('Authorization', `Bearer ${salesOnly}`)).status).toBe(403);
    });

    test('given a customer (no report permissions) then the catalog and every report are 403', async () => {
        const cust = token([], ['customer']);
        expect((await request(app).get('/api/v1/reports')
            .set('Authorization', `Bearer ${cust}`)).status).toBe(403);
        for (const slug of ['cogs', 'valuation', 'shrinkage', 'reservations', 'sales-summary', 'open-purchase-orders']) {
            const res = await request(app)
                .get(`/api/v1/reports/${slug}/results`).set('Authorization', `Bearer ${cust}`);
            expect(res.status).toBe(403);
        }
    });

    test('given an unknown report slug then 404, not 403', async () => {
        const res = await request(app)
            .get('/api/v1/reports/no-such-report/results')
            .set('Authorization', `Bearer ${token(ALL_REPORT_PERMS)}`);
        expect(res.status).toBe(404);
    });

    test('given the catalog then it lists exactly the categories the caller holds', async () => {
        const all = await request(app).get('/api/v1/reports')
            .set('Authorization', `Bearer ${token(ALL_REPORT_PERMS)}`);
        expect(all.status).toBe(200);
        expect(all.body.content.categories.map(c => c.code).sort())
            .toEqual(['finance', 'inventory', 'purchasing', 'sales']);

        const inv = await request(app).get('/api/v1/reports')
            .set('Authorization', `Bearer ${token(['reports:inventory'])}`);
        expect(inv.body.content.categories.map(c => c.code)).toEqual(['inventory']);
        expect(inv.body.content.categories[0].reports.map(r => r.slug).sort())
            .toEqual(['inventory-movements', 'reservations']);

        // Catalog descriptors carry everything a generic UI needs.
        const movements = inv.body.content.categories[0].reports
            .find(r => r.slug === 'inventory-movements');
        expect(movements.mode).toBe('stored');
        expect(movements.params[0]).toMatchObject({ name: 'from', type: 'date' });
        expect(movements.params[0].default).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

describe('given stored reports when runs are generated then snapshots are kept, listed, and downloadable', () => {

    test('given an immediate report then requesting a run is 400, and vice versa', async () => {
        const t = token(ALL_REPORT_PERMS);
        expect((await request(app).post('/api/v1/reports/cogs/runs').send({})
            .set('Authorization', `Bearer ${t}`)).status).toBe(400);
        expect((await request(app).get('/api/v1/reports/inventory-movements/results')
            .set('Authorization', `Bearer ${t}`)).status).toBe(400);
    });

    test('given a queued run when executed then the snapshot holds the ledger rows and a second claim no-ops', async () => {
        const run = await ReportRuns.create({
            slug: 'inventory-movements', trigger: 'manual', requestedBy: staffId,
            params: { from: TODAY, to: TODAY },
        });
        expect(run.status).toBe('queued');

        const finished = await RunService.executeRun(run.run_no);
        expect(finished.status).toBe('succeeded');
        expect(finished.row_count).toBeGreaterThanOrEqual(4);   // our receipts + sales + write-off

        const stored = await ReportRuns.get(run.run_no);
        const skus = stored.result.map(r => r.sku);
        expect(skus).toContain(`RPT-${RUN}-Alph`);

        // Already claimed — re-execution must refuse, not double-run.
        expect(await RunService.executeRun(run.run_no)).toBeNull();
    });

    test('given a scheduled generation then it stores a run with default params and no requester', async () => {
        const finished = await RunService.runScheduled('monthly-sales');
        expect(finished.status).toBe('succeeded');
        expect(finished.trigger).toBe('schedule');
        expect(finished.requested_by).toBeNull();
        expect(finished.params.month).toMatch(/^\d{4}-\d{2}$/);
    });

    test('given a manual run through the API then a subprocess generates it and CSV download works', async () => {
        const t = token(['reports:inventory']);
        const started = await request(app)
            .post('/api/v1/reports/inventory-movements/runs')
            .send({ from: TODAY, to: TODAY })
            .set('Authorization', `Bearer ${t}`);
        expect(started.status).toBe(202);
        const runNo = started.body.content.run.run_no;
        expect(started.body.content.run.status).toBe('queued');

        // The detached runner subprocess claims and completes it.
        let run;
        const deadline = Date.now() + 12000;
        do {
            await new Promise(r => setTimeout(r, 500));
            const res = await request(app)
                .get(`/api/v1/reports/inventory-movements/runs/${runNo}`)
                .set('Authorization', `Bearer ${t}`);
            expect(res.status).toBe(200);
            run = res.body.content.run;
        } while (!['succeeded', 'failed'].includes(run.status) && Date.now() < deadline);

        expect(run.status).toBe('succeeded');
        expect(Number(run.requested_by)).toBe(staffId);   // BIGINT serializes as string
        expect(Array.isArray(run.rows)).toBe(true);
        expect(run.columns.map(c => c.key)).toContain('sku');

        // Runs list shows it (summaries only).
        const list = await request(app)
            .get('/api/v1/reports/inventory-movements/runs')
            .set('Authorization', `Bearer ${t}`);
        expect(list.status).toBe(200);
        expect(list.body.content.runs.map(r => r.run_no)).toContain(runNo);
        expect(list.body.content.runs[0].result).toBeUndefined();

        // CSV download.
        const csv = await request(app)
            .get(`/api/v1/reports/inventory-movements/runs/${runNo}/download`)
            .set('Authorization', `Bearer ${t}`);
        expect(csv.status).toBe(200);
        expect(csv.headers['content-type']).toMatch(/text\/csv/);
        expect(csv.headers['content-disposition']).toContain(`inventory-movements-${runNo}.csv`);
        expect(csv.text.split('\r\n')[0]).toBe('Date,Type,SKU,Product,Warehouse,Qty,Unit cost,Reason,Source');

        // A run is only addressable under its own report.
        const cross = await request(app)
            .get(`/api/v1/reports/monthly-sales/runs/${runNo}`)
            .set('Authorization', `Bearer ${token(['reports:sales'])}`);
        expect(cross.status).toBe(404);
    });
});
