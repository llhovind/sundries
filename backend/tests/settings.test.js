'use strict';

/**
 * Store configuration API tests — settings values, shipping rules, weight
 * bands, tax rates, warehouses (all under /api/v1/settings, settings:manage).
 *
 * Mutated app_settings values are restored afterward: the suite runs against
 * the shared dev database.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');

const RUN = Date.now();

function tokenFor(perms) {
    return jwt.sign(
        { sub: 1, email: 'settings-admin@example.com', role: 'admin', roles: ['admin'], perms },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: '5m' }
    );
}

const MANAGER = tokenFor(['settings:manage']);
const OUTSIDER = tokenFor(['inventory:read', 'orders:read']);

function api(method, path, token = MANAGER) {
    return request(app)[method](path).set('Authorization', `Bearer ${token}`);
}

const created = { rules: [], bands: [], rates: [], warehouses: [] };
let originalStoreName;

beforeAll(async () => {
    const res = await db.query(`SELECT value FROM app_settings WHERE key = 'store.name'`);
    originalStoreName = res.rows[0].value;
});

afterAll(async () => {
    await db.query(`UPDATE app_settings SET value = $1::jsonb WHERE key = 'store.name'`,
        [JSON.stringify(originalStoreName)]);
    if (created.rules.length)      await db.query(`DELETE FROM shipping_rules WHERE rule_no = ANY($1)`, [created.rules]);
    if (created.bands.length)      await db.query(`DELETE FROM shipping_weight_bands WHERE band_no = ANY($1)`, [created.bands]);
    if (created.rates.length)      await db.query(`DELETE FROM tax_rates WHERE rate_no = ANY($1)`, [created.rates]);
    if (created.warehouses.length) await db.query(`DELETE FROM warehouses WHERE warehouse_no = ANY($1)`, [created.warehouses]);
    await pool.end();
});

describe('given the settings surface when callers lack settings:manage then access is denied', () => {

    test('given other staff permissions when listing values then 403', async () => {
        const res = await api('get', '/api/v1/settings/values', OUTSIDER);
        expect(res.status).toBe(403);
    });

    test('given other staff permissions when mutating a warehouse then 403', async () => {
        const res = await api('post', '/api/v1/settings/warehouses', OUTSIDER).send({ code: 'X', name: 'X' });
        expect(res.status).toBe(403);
    });
});

describe('given app settings values when edited then types and domains are enforced', () => {

    test('given the seeded keys when listing then known settings appear with values', async () => {
        const res = await api('get', '/api/v1/settings/values');
        expect(res.status).toBe(200);
        const keys = res.body.content.settings.map(s => s.key);
        expect(keys).toEqual(expect.arrayContaining(['store.name', 'reservations.ttl_minutes', 'tax.provider']));
    });

    test('given a string setting when updated with a string then the new value persists', async () => {
        const res = await api('put', '/api/v1/settings/values/store.name')
            .send({ value: `Test Store ${RUN}` });
        expect(res.status).toBe(200);
        expect(res.body.content.setting.value).toBe(`Test Store ${RUN}`);
    });

    test('given a numeric setting when updated with a string then 400 names the expected type', async () => {
        const res = await api('put', '/api/v1/settings/values/reservations.ttl_minutes')
            .send({ value: 'twenty' });
        expect(res.status).toBe(400);
        expect(res.body.outcome.message).toMatch(/number/);
    });

    test('given a provider setting when set to an unknown adapter then 400', async () => {
        const res = await api('put', '/api/v1/settings/values/tax.provider')
            .send({ value: 'avalara' });
        expect(res.status).toBe(400);
        expect(res.body.outcome.message).toMatch(/local, stripe/);
    });

    test('given a key that does not exist when updated then 404 (keys are code-defined)', async () => {
        const res = await api('put', '/api/v1/settings/values/no.such.key').send({ value: 'x' });
        expect(res.status).toBe(404);
    });

    test('given a key naming an Object.prototype member when updated then 404, never an inherited callable', async () => {
        // The domain-guard lookup is a Map so these resolve to nothing rather
        // than to Object.prototype.constructor and friends. A 500 here would
        // mean an inherited function was invoked as though it were a guard.
        for (const key of ['constructor', '__proto__', 'toString', 'valueOf']) {
            const res = await api('put', `/api/v1/settings/values/${key}`).send({ value: 'x' });
            expect(res.status).toBe(404);
        }
    });
});

describe('given shipping rules and bands when managed then ranges are validated', () => {

    test('given a valid rule when created then it is returned and listed', async () => {
        const res = await api('post', '/api/v1/settings/shipping-rules').send({
            name: `test-rule-${RUN}`, min_subtotal: 0, max_subtotal: 25, base_amount: 4.95, priority: 900,
        });
        expect(res.status).toBe(201);
        created.rules.push(res.body.content.rule.rule_no);

        const list = await api('get', '/api/v1/settings/shipping-rules');
        expect(list.body.content.rules.map(r => r.name)).toContain(`test-rule-${RUN}`);
    });

    test('given max_subtotal below min_subtotal when creating then 400', async () => {
        const res = await api('post', '/api/v1/settings/shipping-rules').send({
            name: 'bad', min_subtotal: 50, max_subtotal: 10, base_amount: 1,
        });
        expect(res.status).toBe(400);
        expect(res.body.outcome.message).toMatch(/max_subtotal/);
    });

    test('given an existing rule when disabled then the update persists', async () => {
        const create = await api('post', '/api/v1/settings/shipping-rules').send({
            name: `toggle-rule-${RUN}`, min_subtotal: 0, base_amount: 1, priority: 901,
        });
        const rule = create.body.content.rule;
        created.rules.push(rule.rule_no);

        const res = await api('put', `/api/v1/settings/shipping-rules/${rule.rule_no}`).send({
            ...rule, status: 'inactive',
        });
        expect(res.status).toBe(200);
        expect(res.body.content.rule.status).toBe('inactive');
    });

    test('given a weight band without a surcharge when creating then 400', async () => {
        const res = await api('post', '/api/v1/settings/weight-bands').send({ min_weight_lbs: 10 });
        expect(res.status).toBe(400);
        expect(res.body.outcome.message).toMatch(/surcharge/);
    });

    test('given a valid weight band when created then it is listed', async () => {
        const res = await api('post', '/api/v1/settings/weight-bands').send({
            min_weight_lbs: 900, max_weight_lbs: 901, surcharge: 12.5,
        });
        expect(res.status).toBe(201);
        created.bands.push(res.body.content.band.band_no);
    });
});

describe('given tax rates when managed then the fraction bound blocks percent typos', () => {

    test('given a valid rate when created then country and state are normalized to uppercase', async () => {
        const res = await api('post', '/api/v1/settings/tax-rates').send({
            country: 'us', state: 'wa', rate: 0.065, name: `test-wa-${RUN}`,
        });
        expect(res.status).toBe(201);
        created.rates.push(res.body.content.rate.rate_no);
        expect(res.body.content.rate.country).toBe('US');
        expect(res.body.content.rate.state).toBe('WA');
    });

    test('given a rate above 1 when creating then 400 explains rates are fractions', async () => {
        const res = await api('post', '/api/v1/settings/tax-rates').send({
            country: 'US', rate: 8.25, name: 'typo',
        });
        expect(res.status).toBe(400);
        expect(res.body.outcome.message).toMatch(/fraction/);
    });
});

describe('given warehouses when managed then codes are unique and immutable', () => {

    test('given a valid warehouse when created then the code is normalized to uppercase', async () => {
        const res = await api('post', '/api/v1/settings/warehouses').send({
            code: `tst-${RUN}`, name: 'Test DC', wh_type: 'standard', priority: 950,
        });
        expect(res.status).toBe(201);
        created.warehouses.push(res.body.content.warehouse.warehouse_no);
        expect(res.body.content.warehouse.code).toBe(`TST-${RUN}`);
    });

    test('given a duplicate code when creating then 409', async () => {
        const res = await api('post', '/api/v1/settings/warehouses').send({
            code: `TST-${RUN}`, name: 'Duplicate',
        });
        expect(res.status).toBe(409);
    });

    test('given an invalid wh_type when creating then 400', async () => {
        const res = await api('post', '/api/v1/settings/warehouses').send({
            code: `TST2-${RUN}`, name: 'Bad type', wh_type: 'floating',
        });
        expect(res.status).toBe(400);
        expect(res.body.outcome.message).toMatch(/standard, transport/);
    });

    test('given an existing warehouse when updated then code stays and fields change', async () => {
        const no = created.warehouses[0];
        const res = await api('put', `/api/v1/settings/warehouses/${no}`).send({
            name: 'Renamed DC', wh_type: 'standard', priority: 951, status: 'inactive',
        });
        expect(res.status).toBe(200);
        expect(res.body.content.warehouse.code).toBe(`TST-${RUN}`);
        expect(res.body.content.warehouse.status).toBe('inactive');
    });
});
