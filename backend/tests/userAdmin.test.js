'use strict';

/**
 * User administration integration tests — list filters, user creation, and
 * role management through the full Route→Controller→Model→DB path.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');
const Rbac  = require('../models/rbac');
const Users = require('../models/users');

const RUN = Date.now();
const TAG = `useradm-${RUN}`;

/** Forge an access token the way routes/auth.js mints them. */
function tokenFor(user, perms, roles) {
    return jwt.sign(
        { sub: user.id, email: user.email, role: user.role, roles, perms },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: '5m' }
    );
}

let admin, adminToken;

function listUsers(query) {
    return request(app)
        .get('/api/v1/users')
        .query({ q: TAG, ...query })
        .set('Authorization', `Bearer ${adminToken}`);
}

beforeAll(async () => {
    admin      = await Users.create({ email: `${TAG}-admin@example.com`, role: 'admin' }, 1);
    adminToken = tokenFor(admin, ['users:manage'], ['admin']);

    await Users.create({ email: `${TAG}-fin@example.com`,  role: 'finance' },  1);
    await Users.create({ email: `${TAG}-ful@example.com`,  role: 'fulfillment' }, 1);
    await Users.create({ email: `${TAG}-cust@example.com`, role: 'customer' }, 1);

    // Primary role customer, but holds a staff grant — must still count as staff
    const hybrid = await Users.create({ email: `${TAG}-hybrid@example.com`, role: 'customer' }, 1);
    await Rbac.grantRole(hybrid.id, 'finance', 1);

    const inactive = await Users.create({ email: `${TAG}-off@example.com`, role: 'finance' }, 1);
    await Users.deactivate(inactive.id);
});

afterAll(async () => {
    // user_roles.granted_by is NO ACTION — clear grants made BY test users
    // before deleting them, or the per-row FK check can fire mid-cascade.
    await db.query(
        `UPDATE user_roles SET granted_by = NULL
         WHERE granted_by IN (SELECT id FROM users WHERE email LIKE $1)`,
        [`${TAG}-%@example.com`]
    );
    await db.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-%@example.com`]);
    await pool.end();
});

describe('given the users listing when filters are applied then only matching users return', () => {

    test('given no filters then all tagged users return with their granted roles', async () => {
        const res = await listUsers();
        expect(res.status).toBe(200);
        const users = res.body.content.users;
        expect(users).toHaveLength(6);
        expect(users.find(u => u.email === `${TAG}-hybrid@example.com`).roles.sort())
            .toEqual(['customer', 'finance']);
    });

    test('given staff=true then pure customers are excluded but staff-granted hybrids remain', async () => {
        const res = await listUsers({ staff: 'true' });
        expect(res.status).toBe(200);
        const emails = res.body.content.users.map(u => u.email);
        expect(emails).not.toContain(`${TAG}-cust@example.com`);
        expect(emails).toContain(`${TAG}-hybrid@example.com`);
        expect(res.body.content.total).toBe(5);
    });

    test('given a role filter then only users with that primary role return', async () => {
        const res = await listUsers({ role: 'finance' });
        expect(res.status).toBe(200);
        const users = res.body.content.users;
        expect(users.length).toBe(2);
        expect(users.every(u => u.role === 'finance')).toBe(true);
    });

    test('given a status filter then only users in that status return', async () => {
        const res = await listUsers({ status: 'inactive' });
        expect(res.status).toBe(200);
        expect(res.body.content.users.map(u => u.email))
            .toEqual([`${TAG}-off@example.com`]);
    });

    test('given combined filters then they intersect', async () => {
        const res = await listUsers({ staff: 'true', status: 'active', role: 'finance' });
        expect(res.status).toBe(200);
        expect(res.body.content.users.map(u => u.email))
            .toEqual([`${TAG}-fin@example.com`]);
    });

    test('given an invalid status filter then the request is rejected with 400', async () => {
        const res = await listUsers({ status: 'banned' });
        expect(res.status).toBe(400);
    });
});

describe('given the create-user endpoint when called then privilege is always explicit', () => {

    function createUser(body) {
        return request(app)
            .post('/api/v1/users')
            .set('Authorization', `Bearer ${adminToken}`)
            .send(body);
    }

    test('given email, role and username then the user is created with a role grant', async () => {
        const email    = `${TAG}-new@example.com`;
        const username = `New Staffer ${RUN}`;   // users.username is unique (case-insensitive)
        const res = await createUser({ email, role: 'fulfillment', username });
        expect(res.status).toBe(201);
        expect(res.body.content.user).toMatchObject({ email, role: 'fulfillment', username });
        expect(await Rbac.getRolesForUser(res.body.content.user.id)).toEqual(['fulfillment']);
    });

    test('given no role then the request is rejected with 400 (no implicit privilege)', async () => {
        const res = await createUser({ email: `${TAG}-norole@example.com` });
        expect(res.status).toBe(400);
    });

    test('given an unknown role then the request is rejected with 400', async () => {
        const res = await createUser({ email: `${TAG}-badrole@example.com`, role: 'warlock' });
        expect(res.status).toBe(400);
    });

    test('given a duplicate email then the request is rejected with 409', async () => {
        const res = await createUser({ email: `${TAG}-fin@example.com`, role: 'finance' });
        expect(res.status).toBe(409);
    });
});

describe('given the role-grant endpoints when called then grants change and are reported back', () => {

    test('given a grant then 201 with the full role list, and revoke removes it', async () => {
        const u = await Users.create({ email: `${TAG}-grant@example.com`, role: 'fulfillment' }, 1);

        const granted = await request(app)
            .post(`/api/v1/users/${u.id}/roles`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ role: 'finance' });
        expect(granted.status).toBe(201);
        expect(granted.body.content.roles.sort()).toEqual(['finance', 'fulfillment']);

        const revoked = await request(app)
            .delete(`/api/v1/users/${u.id}/roles/finance`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(revoked.status).toBe(200);
        expect(revoked.body.content.roles).toEqual(['fulfillment']);
    });

    test('given a revoke of the only role then the request is rejected with 409', async () => {
        const u = await Users.create({ email: `${TAG}-lastrole@example.com`, role: 'finance' }, 1);
        const res = await request(app)
            .delete(`/api/v1/users/${u.id}/roles/finance`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(409);
    });
});
