'use strict';

/**
 * Anonymous storefront tests: guests browse the catalog (products,
 * categories, search, promo validation) without a token, never see
 * draft/inactive products, and cannot reach any write or account routes.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');

const RUN = Date.now();

const staffToken = () => jwt.sign(
    { sub: 1, email: 's@t.l', role: 'admin', roles: ['admin'], perms: ['catalog:write'] },
    process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }
);

afterAll(async () => {
    await pool.end();
});

describe('given an anonymous guest when browsing the catalog then public reads work', () => {

    let activeNo, draftNo;

    beforeAll(async () => {
        const mk = async (status) => {
            const res = await request(app).post('/api/v1/products')
                .set('Authorization', `Bearer ${staffToken()}`)
                .send({ name: `Guest ${status} ${RUN}`, sell_method: 'unit', base_uom: 'each', status });
            return res.body.content.product_no;
        };
        activeNo = await mk('active');
        draftNo  = await mk('draft');
    });

    test('given no token when listing products then 200 and drafts are hidden', async () => {
        const res = await request(app).get(`/api/v1/products?q=Guest&pageSize=100`);
        expect(res.status).toBe(200);
        const numbers = res.body.content.products.map(p => p.product_no);
        expect(numbers).toContain(activeNo);
        expect(numbers).not.toContain(draftNo);
    });

    test('given no token when fetching a product then active is returned and draft is 404', async () => {
        const active = await request(app).get(`/api/v1/products/${activeNo}`);
        expect(active.status).toBe(200);
        expect(active.body.content.product.name).toBe(`Guest active ${RUN}`);

        const draft = await request(app).get(`/api/v1/products/${draftNo}`);
        expect(draft.status).toBe(404);
    });

    test('given no token when listing categories then 200', async () => {
        const res = await request(app).get('/api/v1/categories');
        expect(res.status).toBe(200);
        expect(res.body.content).toHaveProperty('categories');
    });

    test('given no token when searching products then 200 with results envelope', async () => {
        const res = await request(app).get(`/api/v1/search/products?q=Guest`);
        expect(res.status).toBe(200);
        expect(res.body.content).toHaveProperty('products');
    });

    test('given no token when validating an unknown promo code then 400, not 401', async () => {
        const res = await request(app).post('/api/v1/promotions/validate')
            .send({ code: `NOPE-${RUN}`, subtotal: 100 });
        expect(res.status).toBe(400);
    });
});

describe('given an anonymous guest when touching protected routes then access is denied', () => {

    test('given no token when writing to the catalog then 401', async () => {
        const product = await request(app).post('/api/v1/products')
            .send({ name: `Blocked ${RUN}` });
        expect(product.status).toBe(401);

        const category = await request(app).post('/api/v1/categories')
            .send({ name: `Blocked ${RUN}` });
        expect(category.status).toBe(401);

        const promo = await request(app).post('/api/v1/promotions')
            .send({ code: `BLOCKED${RUN}` });
        expect(promo.status).toBe(401);
    });

    test('given no token when using account routes then 401', async () => {
        expect((await request(app).get('/api/v1/cart')).status).toBe(401);
        expect((await request(app).post('/api/v1/checkout').send({})).status).toBe(401);
        expect((await request(app).get('/api/v1/orders')).status).toBe(401);
    });

    test('given an invalid token when browsing then 401 so the client refresh flow can run', async () => {
        const res = await request(app).get('/api/v1/products')
            .set('Authorization', 'Bearer not-a-real-token');
        expect(res.status).toBe(401);
    });
});
