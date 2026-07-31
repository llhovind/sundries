'use strict';

/**
 * Integration tests for the pluggable infrastructure services: the search
 * port (Postgres FTS + outbox pipeline), provider-registry resolution for
 * search and mail (env wins, unknown providers fail loud), fraud screening,
 * and the pg-boss job runner (queued vs. inline execution).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');
const PostgresSearch   = require('../services/search/postgresAdapter');
const { getSearchProvider } = require('../services/search');
const { getMailProvider }   = require('../services/mail');
const FraudService = require('../services/fraudService');
const Jobs         = require('../services/jobs');

const RUN = Date.now();

function token() {
    return jwt.sign(
        { sub: 1, email: 'admin@test.local', role: 'admin', roles: ['admin'], perms: [] },
        process.env.JWT_ACCESS_SECRET, { expiresIn: '5m' }
    );
}

async function makeProduct(name, { brand = null, descr = null, price = 10 } = {}) {
    const p = await db.query(
        `INSERT INTO products (name, brand, descr, status) VALUES ($1, $2, $3, 'active')
         RETURNING product_no`,
        [name, brand, descr]);
    const productNo = Number(p.rows[0].product_no);
    await db.query(
        `INSERT INTO product_variants (_product_no, sku, price) VALUES ($1, $2, $3)`,
        [productNo, `P5-${RUN}-${productNo}`, price]);
    return productNo;
}

async function makeGuestOrder(email) {
    const cust = await db.query(
        `INSERT INTO customers (name, email, is_guest) VALUES ('Fraud Test', $1, TRUE) RETURNING id`,
        [email]);
    const ord = await db.query(
        `INSERT INTO orders (_customer_id, email, subtotal, total, ship_country)
         VALUES ($1, $2, 10, 10, 'US') RETURNING ord_no`,
        [cust.rows[0].id, email]);
    return Number(ord.rows[0].ord_no);
}

afterAll(async () => {
    await Jobs.stop();
    await pool.end();
});

describe('given catalog products when searched through the port then Postgres FTS finds them', () => {

    test('given a product name word then search ranks and returns it with price info', async () => {
        const marker = `zephyrium${RUN}`;
        await makeProduct(`Deluxe ${marker} Lantern`, { brand: 'Acme', descr: 'A very bright lantern', price: 42 });

        const { hits, total } = await PostgresSearch.search(marker);
        expect(total).toBe(1);
        expect(hits[0].name).toContain('Lantern');
        expect(Number(hits[0].price_from)).toBe(42);
        expect(hits[0].variant_count).toBe(1);
    });

    test('given a prefix of the name then the ILIKE fallback still matches', async () => {
        const marker = `Quixotic${RUN}`;
        await makeProduct(`${marker} Gadget`);
        const { total } = await PostgresSearch.search(marker.slice(0, 12));
        expect(total).toBeGreaterThanOrEqual(1);
    });

    test('given inactive products then they never appear in results', async () => {
        const marker = `hiddenite${RUN}`;
        const p = await makeProduct(`Secret ${marker}`);
        await db.query(`UPDATE products SET status = 'inactive' WHERE product_no = $1`, [p]);
        const { total } = await PostgresSearch.search(marker);
        expect(total).toBe(0);
    });

    test('given the search route then results return through the API envelope', async () => {
        const marker = `routeable${RUN}`;
        await makeProduct(`The ${marker} Widget`);
        const res = await request(app)
            .get(`/api/v1/search/products?q=${marker}`)
            .set('Authorization', `Bearer ${token()}`);
        expect(res.status).toBe(200);
        expect(res.body.content.provider).toBe('postgres');
        expect(res.body.content.total).toBe(1);
    });

    test('given catalog writes then the outbox trigger enqueues, and draining marks processed', async () => {
        const p = await makeProduct(`Outboxed ${RUN}`);
        const pending = await db.query(
            `SELECT op FROM search_outbox WHERE _product_no = $1 AND processed_at IS NULL`, [p]);
        // product insert + variant insert both enqueue
        expect(pending.rows.length).toBeGreaterThanOrEqual(2);
        expect(pending.rows.every(r => r.op === 'upsert')).toBe(true);

        await PostgresSearch.processOutbox();
        const after = await db.query(
            `SELECT COUNT(*)::int AS n FROM search_outbox WHERE _product_no = $1 AND processed_at IS NULL`, [p]);
        expect(after.rows[0].n).toBe(0);
    });

    test('given deactivation then the outbox records a delete op for the index', async () => {
        const p = await makeProduct(`Retiring ${RUN}`);
        await PostgresSearch.processOutbox();
        await db.query(`UPDATE products SET status = 'inactive' WHERE product_no = $1`, [p]);
        const rows = await db.query(
            `SELECT op FROM search_outbox WHERE _product_no = $1 AND processed_at IS NULL`, [p]);
        expect(rows.rows.map(r => r.op)).toContain('delete');
    });
});

describe('given provider registries when resolving then env wins and unknowns fail loud', () => {

    // Restore after each test — the test env pins MAIL_PROVIDER=noop so
    // suites that place paid orders never email real inboxes.
    const originalMailProvider = process.env.MAIL_PROVIDER;
    afterEach(() => { process.env.MAIL_PROVIDER = originalMailProvider; });

    test('given no provider in the environment then postgres search and smtp mail are the fallbacks', async () => {
        expect((await getSearchProvider()).provider).toBe('postgres');
        delete process.env.MAIL_PROVIDER;
        expect((await getMailProvider()).provider).toBe('smtp');
    });

    test('given an unknown provider in env then resolution throws a clear error', async () => {
        process.env.SEARCH_PROVIDER = 'altavista';
        await expect(getSearchProvider()).rejects.toThrow(/Unknown search provider/);
        delete process.env.SEARCH_PROVIDER;

        process.env.MAIL_PROVIDER = 'pigeon';
        await expect(getMailProvider()).rejects.toThrow(/Unknown mail provider/);
    });
});

describe('given suspicious orders when screened then they are flagged for review, never blocked', () => {

    test('given a disposable email domain then the order is flagged with the reason', async () => {
        const ordNo = await makeGuestOrder(`shady-${RUN}@mailinator.com`);
        const verdict = await FraudService.screenAndFlag(ordNo);
        expect(verdict.flagged).toBe(true);
        expect(verdict.reasons.join()).toMatch(/disposable email/);

        const row = await db.query(`SELECT fraud_flag, fraud_notes FROM orders WHERE ord_no = $1`, [ordNo]);
        expect(row.rows[0].fraud_flag).toBe(true);
        expect(row.rows[0].fraud_notes).toMatch(/mailinator/);
    });

    test('given more than 5 orders in an hour from one email then velocity flags it', async () => {
        const email = `velocity-${RUN}@example.com`;
        let last;
        for (let i = 0; i < 6; i++) last = await makeGuestOrder(email);
        const verdict = await FraudService.screen({ ord_no: last, email, ship_country: 'US' });
        expect(verdict.flagged).toBe(true);
        expect(verdict.reasons.join()).toMatch(/velocity/);
    });

    test('given a normal order then no flag is raised', async () => {
        const ordNo = await makeGuestOrder(`normal-${RUN}@example.com`);
        const verdict = await FraudService.screenAndFlag(ordNo);
        expect(verdict.flagged).toBe(false);
        const row = await db.query(`SELECT fraud_flag FROM orders WHERE ord_no = $1`, [ordNo]);
        expect(row.rows[0].fraud_flag).toBe(false);
    });
});

describe('given the job runner when work is sent then it executes queued or inline', () => {

    test('given the queue is not running then Jobs.send executes the handler inline', async () => {
        const ordNo = await makeGuestOrder(`inline-${RUN}@yopmail.com`);
        expect(Jobs.isRunning()).toBe(false);
        await Jobs.send(Jobs.QUEUES.ORDER_SCREEN, { ord_no: ordNo });
        const row = await db.query(`SELECT fraud_flag FROM orders WHERE ord_no = $1`, [ordNo]);
        expect(row.rows[0].fraud_flag).toBe(true);   // handler ran synchronously
    });

    // The transport itself is not exercised here: this suite runs on the
    // inline adapter (see tests/setupEnv.js), so what is under test is that
    // Jobs routes through whichever adapter is configured and that the
    // registered consumer is the right one. Delivery through real pg-boss —
    // enqueue, poll, pick up, complete — is covered by
    // tests/integration/queue.pgboss.test.mjs.
    test('given the queue is running then send routes the job to its consumer', async () => {
        await Jobs.start();
        expect(Jobs.isRunning()).toBe(true);

        const ordNo = await makeGuestOrder(`queued-${RUN}@guerrillamail.com`);
        await Jobs.send(Jobs.QUEUES.ORDER_SCREEN, { ord_no: ordNo });

        const row = await db.query(`SELECT fraud_flag FROM orders WHERE ord_no = $1`, [ordNo]);
        expect(row.rows[0].fraud_flag).toBe(true);
    });

    test('given an unknown queue then send fails loud', async () => {
        await expect(Jobs.send('nonexistent-queue', {})).rejects.toThrow(/Unknown job queue/);
    });
});
