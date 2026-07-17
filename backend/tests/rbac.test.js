'use strict';

/**
 * RBAC integration tests — DB-backed permission resolution, role grants with
 * audit, and route-level enforcement via requirePermission.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');
const Rbac  = require('../models/rbac');
const Users = require('../models/users');

const RUN = Date.now();

/** Forge an access token the way routes/auth.js mints them. */
function tokenFor(user, perms, roles) {
    return jwt.sign(
        { sub: user.id, email: user.email, role: user.role, roles, perms },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: '5m' }
    );
}

async function makeUser(role, tag) {
    return Users.create({ email: `rbac-${tag}-${RUN}@example.com`, role }, 1);
}

afterAll(async () => {
    await db.query(`DELETE FROM users WHERE email LIKE $1`, [`rbac-%-${RUN}@example.com`]);
    await pool.end();
});

describe('given seeded roles when permissions are resolved then grants match job duties', () => {

    test('given the bootstrapped admin when resolved then every permission is held', async () => {
        const perms = await Rbac.getPermissionsForUser(1);
        const all   = await db.query('SELECT COUNT(*)::int AS n FROM permissions');
        expect(perms.length).toBe(all.rows[0].n);
    });

    test('given a finance user when resolved then refunds and COGS are held but user management is not', async () => {
        const u = await makeUser('finance', 'fin');
        const perms = await Rbac.getPermissionsForUser(u.id);
        expect(perms).toEqual(expect.arrayContaining(['refunds:create', 'reports:finance', 'orders:read']));
        expect(perms).not.toContain('users:manage');
        expect(perms).not.toContain('inventory:adjust');
    });

    test('given a customer when resolved then no staff permissions are held', async () => {
        const u = await makeUser('customer', 'cust');
        const perms = await Rbac.getPermissionsForUser(u.id);
        expect(perms).toEqual([]);
    });
});

describe('given role grants when changed then permissions and audit follow', () => {

    test('given an extra role granted then permissions extend, and revoke removes them', async () => {
        const u = await makeUser('fulfillment', 'ful');

        expect(await Rbac.getPermissionsForUser(u.id)).not.toContain('refunds:create');

        expect(await Rbac.grantRole(u.id, 'finance', 1)).toBe(true);
        expect(await Rbac.grantRole(u.id, 'finance', 1)).toBe(false);   // idempotent
        expect(await Rbac.getPermissionsForUser(u.id)).toContain('refunds:create');
        expect((await Rbac.getRolesForUser(u.id)).sort()).toEqual(['finance', 'fulfillment']);

        expect(await Rbac.revokeRole(u.id, 'finance', 1)).toBe(true);
        expect(await Rbac.getPermissionsForUser(u.id)).not.toContain('refunds:create');
    });

    test('given an unknown role when granted then a 400-status error is thrown', async () => {
        const u = await makeUser('customer', 'unk');
        await expect(Rbac.grantRole(u.id, 'warlock', 1)).rejects.toMatchObject({ status: 400 });
    });

    test('given a grant and revoke then audit_log records both with the acting user', async () => {
        const u = await makeUser('customer', 'aud');
        await Rbac.grantRole(u.id, 'purchasing', 1);
        await Rbac.revokeRole(u.id, 'purchasing', 1);

        const audit = await db.query(
            `SELECT action, actor_user_id FROM audit_log
             WHERE entity = 'user_roles' AND entity_id = $1 ORDER BY audit_no DESC LIMIT 2`,
            [String(u.id)]
        );
        expect(audit.rows.map(r => r.action).sort()).toEqual(['DELETE', 'INSERT']);
        expect(audit.rows.every(r => Number(r.actor_user_id) === 1)).toBe(true);
    });

    test('given a primary-role change then stale grants are reset (no permission leakage)', async () => {
        const u = await makeUser('admin', 'demote');
        expect(await Rbac.getPermissionsForUser(u.id)).toContain('users:manage');

        await Users.update(u.id, { role: 'customer' }, 1);

        expect(await Rbac.getPermissionsForUser(u.id)).toEqual([]);
        expect(await Rbac.getRolesForUser(u.id)).toEqual(['customer']);
    });
});

describe('given permission-guarded routes when called then enforcement matches the token', () => {

    test('given a token with users:manage then GET /users succeeds', async () => {
        const u = await makeUser('admin', 'route-ok');
        const res = await request(app)
            .get('/api/v1/users')
            .set('Authorization', `Bearer ${tokenFor(u, ['users:manage'], ['admin'])}`);
        expect(res.status).toBe(200);
    });

    test('given a token without users:manage then GET /users is 403', async () => {
        const u = await makeUser('finance', 'route-no');
        const res = await request(app)
            .get('/api/v1/users')
            .set('Authorization', `Bearer ${tokenFor(u, ['refunds:create'], ['finance'])}`);
        expect(res.status).toBe(403);
    });

    test('given a legacy token without a perms claim then the DB fallback resolves permissions', async () => {
        const u = await makeUser('finance', 'legacy');
        // finance holds customers:read → allowed via DB lookup despite no perms claim
        const legacyToken = jwt.sign(
            { sub: u.id, email: u.email, role: u.role },
            process.env.JWT_ACCESS_SECRET, { expiresIn: '5m' }
        );
        const ok = await request(app)
            .get('/api/v1/customers')
            .set('Authorization', `Bearer ${legacyToken}`);
        expect(ok.status).toBe(200);

        const denied = await request(app)
            .get('/api/v1/users')
            .set('Authorization', `Bearer ${legacyToken}`);
        expect(denied.status).toBe(403);
    });

    test('given no token then guarded routes are 401', async () => {
        const res = await request(app).get('/api/v1/users');
        expect(res.status).toBe(401);
    });

    test('given the roles listing then all seven seeded roles return with permissions', async () => {
        const u = await makeUser('admin', 'roles');
        const res = await request(app)
            .get('/api/v1/users/roles')
            .set('Authorization', `Bearer ${tokenFor(u, ['users:manage'], ['admin'])}`);
        expect(res.status).toBe(200);
        const roles = res.body.content.roles;
        expect(roles.map(r => r.code)).toEqual(expect.arrayContaining(
            ['admin', 'finance', 'purchasing', 'inventory_control', 'fulfillment', 'customer_service', 'customer']
        ));
        expect(roles.find(r => r.code === 'finance').permissions).toContain('refunds:create');
    });
});
