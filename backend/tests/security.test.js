'use strict';

/**
 * Security response headers: helmet is mounted globally, so every response —
 * API JSON, the plain-text root, and static images — carries hardening headers
 * and no longer leaks the Express fingerprint.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const app = require('../app');
const { pool } = require('../common/db');

afterAll(async () => {
    await pool.end();
});

describe('security headers', () => {
    it('given any response when served then the X-Powered-By fingerprint is stripped', async () => {
        const res = await request(app).get('/');
        expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('given any response when served then helmet hardening headers are present', async () => {
        const res = await request(app).get('/');
        // A representative sample across the defence-in-depth set helmet applies.
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
        expect(res.headers['content-security-policy']).toBeDefined();
        expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    });

    it('given an API 404 when served then hardening headers still apply', async () => {
        const res = await request(app).get('/api/v1/does-not-exist');
        expect(res.headers['x-powered-by']).toBeUndefined();
        expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
});
