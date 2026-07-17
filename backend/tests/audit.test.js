'use strict';

/**
 * Audit trail tests — DB trigger writes with actor/request attribution
 * (withAudit + fn_audit_row) and the read API at /api/v1/audit-log
 * (audit:read).
 *
 * audit_log is immutable by trigger, so rows created here cannot be cleaned
 * up; assertions therefore target rows by this run's unique correlation id
 * and record values, never by table-wide counts.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');

const RUN            = Date.now();
const CORRELATION_ID = `audit-test-${RUN}`;

function tokenFor(perms, sub = 1) {
    return jwt.sign(
        { sub, email: 'audit-admin@example.com', role: 'admin', roles: ['admin'], perms },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: '5m' }
    );
}

const ADMIN    = tokenFor(['settings:manage', 'audit:read']);
const OUTSIDER = tokenFor(['inventory:read', 'orders:read']);

function api(method, path, token = ADMIN) {
    return request(app)[method](path).set('Authorization', `Bearer ${token}`);
}

let originalStoreName;
const createdRates = [];

beforeAll(async () => {
    const res = await db.query(`SELECT value FROM app_settings WHERE key = 'store.name'`);
    originalStoreName = res.rows[0].value;
});

afterAll(async () => {
    await db.query(`UPDATE app_settings SET value = $1::jsonb WHERE key = 'store.name'`,
        [JSON.stringify(originalStoreName)]);
    if (createdRates.length) {
        await db.query(`DELETE FROM tax_rates WHERE rate_no = ANY($1)`, [createdRates]);
    }
    await pool.end();
});

describe('given a privileged mutation when it commits then the audit trigger records actor and request context', () => {

    test('given a settings update when committed then the UPDATE row carries actor, ip and correlation id', async () => {
        const res = await api('put', '/api/v1/settings/values/store.name')
            .set('X-Request-Id', CORRELATION_ID)
            .send({ value: `Audit Test Store ${RUN}` });
        expect(res.status).toBe(200);

        const rows = await db.query(
            `SELECT * FROM audit_log WHERE correlation_id = $1 AND entity = 'app_settings'`,
            [CORRELATION_ID]);
        expect(rows.rows).toHaveLength(1);
        const entry = rows.rows[0];
        expect(entry.action).toBe('UPDATE');
        expect(entry.entity_id).toBe('store.name');
        expect(Number(entry.actor_user_id)).toBe(1);
        expect(entry.ip).toBeTruthy();
        expect(entry.new_data.value).toBe(`Audit Test Store ${RUN}`);
        expect(entry.old_data.value).not.toBe(entry.new_data.value);
    });

    test('given a tax rate creation when committed then the INSERT row is attributed', async () => {
        const res = await api('post', '/api/v1/settings/tax-rates')
            .set('X-Request-Id', CORRELATION_ID)
            .send({ country: 'US', state: 'ZZ', rate: 0.05, name: `Audit test rate ${RUN}` });
        expect(res.status).toBe(201);
        createdRates.push(res.body.content.rate.rate_no);

        const rows = await db.query(
            `SELECT * FROM audit_log WHERE correlation_id = $1 AND entity = 'tax_rates' AND action = 'INSERT'`,
            [CORRELATION_ID]);
        expect(rows.rows).toHaveLength(1);
        expect(Number(rows.rows[0].actor_user_id)).toBe(1);
        expect(rows.rows[0].new_data.name).toBe(`Audit test rate ${RUN}`);
    });

    test('given a hostile X-Request-Id header when the request runs then a generated uuid is used instead', async () => {
        const res = await api('put', '/api/v1/settings/values/store.name')
            .set('X-Request-Id', 'evil"header{} injection $(id)')
            .send({ value: `Audit Test Store 2 ${RUN}` });
        expect(res.status).toBe(200);
        expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe('given the audit read API when queried then access and filters are enforced', () => {

    test('given a caller without audit:read when listing then 403', async () => {
        const res = await api('get', '/api/v1/audit-log', OUTSIDER);
        expect(res.status).toBe(403);
    });

    test('given audit:read when searching by this run correlation id then only this run rows return', async () => {
        const res = await api('get', `/api/v1/audit-log?q=${CORRELATION_ID}`);
        expect(res.status).toBe(200);
        const { entries, total } = res.body.content;
        expect(total).toBe(2);
        expect(entries.every(e => e.correlation_id === CORRELATION_ID)).toBe(true);
        const settingsEntry = entries.find(e => e.entity === 'app_settings');
        expect(settingsEntry.entity_id).toBe('store.name');
        expect(Number(settingsEntry.actor_user_id)).toBe(1);
    });

    test('given entity and action filters when combined then only matching rows return', async () => {
        const res = await api('get',
            `/api/v1/audit-log?q=${CORRELATION_ID}&entity=tax_rates&action=INSERT`);
        expect(res.status).toBe(200);
        expect(res.body.content.total).toBe(1);
        expect(res.body.content.entries[0].entity).toBe('tax_rates');
    });

    test('given an invalid action filter when listing then 400', async () => {
        const res = await api('get', '/api/v1/audit-log?action=TRUNCATE');
        expect(res.status).toBe(400);
    });

    test('given a future from-date when listing then no rows return and paging math holds', async () => {
        const res = await api('get',
            `/api/v1/audit-log?q=${CORRELATION_ID}&from=2099-01-01`);
        expect(res.status).toBe(200);
        expect(res.body.content.total).toBe(0);
        expect(res.body.content.entries).toEqual([]);
    });

    test('given the entities endpoint when listed then audited tables appear', async () => {
        const res = await api('get', '/api/v1/audit-log/entities');
        expect(res.status).toBe(200);
        expect(res.body.content.entities).toEqual(expect.arrayContaining(['app_settings', 'tax_rates']));
    });
});
