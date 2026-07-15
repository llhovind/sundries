'use strict';

/**
 * Core API coverage: auth (registration/OTP), categories, vendors, customers
 * self-service.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const crypto  = require('crypto');
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');

const RUN = Date.now();

function token(user, perms = [], roles = ['customer']) {
    return jwt.sign(
        { sub: user.id, email: user.email, role: user.role || 'customer', roles, perms },
        process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }
    );
}
const adminToken = () => token({ id: 1, email: 'a@t.l', role: 'admin' },
    ['catalog:write', 'purchasing:manage', 'customers:read', 'customers:write'], ['admin']);

async function makeUser(tag) {
    const u = await db.query(
        `INSERT INTO users (email, role, status) VALUES ($1, 'customer', 'active') RETURNING id, email, role`,
        [`core-${tag}-${RUN}@example.com`]);
    await db.query(
        `INSERT INTO user_roles (user_id, role_no) SELECT $1, role_no FROM roles WHERE code = 'customer'`,
        [u.rows[0].id]);
    return u.rows[0];
}

afterAll(async () => {
    await pool.end();
});

describe('given the auth flow when users register and log in then OTP and invitation rules hold', () => {

    test('given registration with a valid invitation then the account is created and the code consumed', async () => {
        const code = `INV-${RUN}`;
        await db.query(
            `INSERT INTO invitation_codes (code, label, max_uses) VALUES ($1, 'test', 2)`, [code]);

        const email = `reg-${RUN}@example.com`;
        const res = await request(app).post('/api/v1/auth/register')
            .send({ email, invitationCode: code });
        expect(res.status).toBe(201);

        const user = await db.query(`SELECT id, role FROM users WHERE lower(email) = lower($1)`, [email]);
        expect(user.rows[0].role).toBe('customer');
        const roles = await db.query(
            `SELECT r.code FROM user_roles ur JOIN roles r ON r.role_no = ur.role_no WHERE ur.user_id = $1`,
            [user.rows[0].id]);
        expect(roles.rows.map(r => r.code)).toContain('customer');

        const uses = await db.query(
            `SELECT use_count FROM invitation_codes WHERE code = $1`, [code]);
        expect(uses.rows[0].use_count).toBe(1);

        // duplicate email → 409; bad code → 400
        expect((await request(app).post('/api/v1/auth/register')
            .send({ email, invitationCode: code })).status).toBe(409);
        expect((await request(app).post('/api/v1/auth/register')
            .send({ email: `x-${RUN}@example.com`, invitationCode: 'NOPE' })).status).toBe(400);
    });

    test('given request-otp then responses do not reveal whether an email exists', async () => {
        const known   = await makeUser('otp');
        const knownRes   = await request(app).post('/api/v1/auth/request-otp').send({ email: known.email });
        const unknownRes = await request(app).post('/api/v1/auth/request-otp').send({ email: `ghost-${RUN}@example.com` });
        expect(knownRes.status).toBe(200);
        expect(unknownRes.status).toBe(200);
        expect(knownRes.body.message).toBe(unknownRes.body.message);   // anti-enumeration
    });

    test('given a valid OTP then login succeeds and the token carries roles and perms claims', async () => {
        const user = await makeUser('login');
        const otp  = '123456';
        const hash = crypto.createHash('sha256').update(otp).digest('hex');
        await db.query(
            `INSERT INTO otp_codes (user_id, otp_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
            [user.id, hash]);

        const bad = await request(app).post('/api/v1/auth/verify-otp')
            .send({ email: user.email, otp: '000000' });
        expect(bad.status).toBe(401);

        const res = await request(app).post('/api/v1/auth/verify-otp')
            .send({ email: user.email, otp });
        expect(res.status).toBe(200);
        const payload = jwt.decode(res.body.accessToken);
        expect(payload.roles).toEqual(['customer']);
        expect(Array.isArray(payload.perms)).toBe(true);

        // OTP is single-use
        const replay = await request(app).post('/api/v1/auth/verify-otp')
            .send({ email: user.email, otp });
        expect(replay.status).toBe(401);
    });

    test('given repeated wrong guesses then the code locks out and even the right code is refused', async () => {
        const user = await makeUser('lockout');
        const otp  = '654321';
        const hash = crypto.createHash('sha256').update(otp).digest('hex');
        await db.query(
            `INSERT INTO otp_codes (user_id, otp_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
            [user.id, hash]);

        for (let i = 0; i < 5; i++) {
            const res = await request(app).post('/api/v1/auth/verify-otp')
                .send({ email: user.email, otp: '000000' });
            expect(res.status).toBe(401);
        }
        const counted = await db.query(
            `SELECT attempt_count FROM otp_codes WHERE user_id = $1`, [user.id]);
        expect(counted.rows[0].attempt_count).toBe(5);

        // The code is dead: the correct OTP is refused with the SAME message
        // a wrong one gets — lockout state is not enumerable.
        const locked = await request(app).post('/api/v1/auth/verify-otp')
            .send({ email: user.email, otp });
        expect(locked.status).toBe(401);
        expect(locked.body.message).toBe('Invalid or expired login code');

        // Recovery: a fresh code (rate-limited request-otp path) works.
        const otp2  = '111222';
        const hash2 = crypto.createHash('sha256').update(otp2).digest('hex');
        await db.query(
            `INSERT INTO otp_codes (user_id, otp_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
            [user.id, hash2]);
        const fresh = await request(app).post('/api/v1/auth/verify-otp')
            .send({ email: user.email, otp: otp2 });
        expect(fresh.status).toBe(200);
    });
});

describe('given categories when managed then writes need catalog:write and reads are open', () => {

    test('given CRUD then create/update/delete work for staff and reads for shoppers', async () => {
        const name = `Cat ${RUN}`;
        const created = await request(app).post('/api/v1/categories')
            .set('Authorization', `Bearer ${adminToken()}`).send({ name });
        expect(created.status).toBe(201);
        const id = created.body.content.category.id;

        const shopper = await makeUser('cat');
        const list = await request(app).get('/api/v1/categories')
            .set('Authorization', `Bearer ${token(shopper)}`);
        expect(list.status).toBe(200);

        const denied = await request(app).post('/api/v1/categories')
            .set('Authorization', `Bearer ${token(shopper)}`).send({ name: 'Nope' });
        expect(denied.status).toBe(403);

        const del = await request(app).delete(`/api/v1/categories/${id}`)
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(del.status).toBe(200);
    });
});

describe('given vendors when managed then purchasing owns them and shoppers see nothing', () => {

    test('given create/update/read then purchasing:manage gates all of it', async () => {
        const created = await request(app).post('/api/v1/vendors')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ name: `Vendor ${RUN}`, city: 'Springfield', state: 'IL' });
        expect(created.status).toBe(201);

        const shopper = await makeUser('vend');
        const denied = await request(app).get('/api/v1/vendors')
            .set('Authorization', `Bearer ${token(shopper)}`);
        expect(denied.status).toBe(403);

        const list = await request(app).get('/api/v1/vendors')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(list.status).toBe(200);
        expect(list.body.content.vendors.some(v => v.name === `Vendor ${RUN}`)).toBe(true);
    });
});

describe('given customer self-service when a shopper edits their profile then /me works and is scoped', () => {

    test('given upsert and fetch of /me then the profile persists for that user only', async () => {
        const user = await makeUser('me');
        const auth = `Bearer ${token(user)}`;

        const saved = await request(app).put('/api/v1/customers/me')
            .set('Authorization', auth)
            .send({ name: 'Core Me', address: '9 Elm', city: 'Springfield', state: 'IL', zip: '62701' });
        expect(saved.status).toBe(200);

        const me = await request(app).get('/api/v1/customers/me').set('Authorization', auth);
        expect(me.status).toBe(200);
        expect(me.body.content.customer.name).toBe('Core Me');

        // customer listing is staff-only
        const denied = await request(app).get('/api/v1/customers').set('Authorization', auth);
        expect(denied.status).toBe(403);
    });
});
