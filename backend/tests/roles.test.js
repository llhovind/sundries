'use strict';

/**
 * Roles & permissions editor integration tests — role CRUD, permission-set
 * replacement, locked-role guard rails, and roles:manage enforcement.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');
const Rbac  = require('../models/rbac');
const Users = require('../models/users');

const RUN  = Date.now();
const CODE = `test_role_${RUN}`;

function tokenFor(user, perms, roles) {
    return jwt.sign(
        { sub: user.id, email: user.email, role: user.role, roles, perms },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: '5m' }
    );
}

let admin, adminToken;

function api() {
    return {
        get:  (p)       => request(app).get(`/api/v1/roles${p}`).set('Authorization', `Bearer ${adminToken}`),
        post: (p, body) => request(app).post(`/api/v1/roles${p}`).set('Authorization', `Bearer ${adminToken}`).send(body),
        put:  (p, body) => request(app).put(`/api/v1/roles${p}`).set('Authorization', `Bearer ${adminToken}`).send(body),
        del:  (p)       => request(app).delete(`/api/v1/roles${p}`).set('Authorization', `Bearer ${adminToken}`),
    };
}

beforeAll(async () => {
    admin      = await Users.create({ email: `roles-admin-${RUN}@example.com`, role: 'admin' }, 1);
    adminToken = tokenFor(admin, ['roles:manage'], ['admin']);
});

afterAll(async () => {
    await db.query(
        `UPDATE user_roles SET granted_by = NULL
         WHERE granted_by IN (SELECT id FROM users WHERE email LIKE $1)`,
        [`roles-%-${RUN}@example.com`]
    );
    // Users first: users.role references roles(code)
    await db.query(`DELETE FROM users WHERE email LIKE $1`, [`roles-%-${RUN}@example.com`]);
    await db.query(`DELETE FROM roles WHERE code LIKE 'test_role_%'`);
    await pool.end();
});

describe('given the roles listing when requested then roles and the permission catalog return', () => {

    test('given roles:manage then GET /roles returns every seeded role with permissions and counts', async () => {
        const res = await api().get('/');
        expect(res.status).toBe(200);
        const adminRole = res.body.content.roles.find(r => r.code === 'admin');
        expect(adminRole.permissions).toContain('roles:manage');
        expect(typeof adminRole.user_count).toBe('number');
    });

    test('given roles:manage then GET /roles/permissions returns the full catalog', async () => {
        const res = await api().get('/permissions');
        expect(res.status).toBe(200);
        const codes = res.body.content.permissions.map(p => p.code);
        expect(codes).toEqual(expect.arrayContaining(['users:manage', 'roles:manage', 'catalog:write']));
    });

    test('given a token without roles:manage then every roles endpoint is 403', async () => {
        const u = await Users.create({ email: `roles-nomanage-${RUN}@example.com`, role: 'finance' }, 1);
        const t = tokenFor(u, ['users:manage'], ['finance']);   // users:manage is NOT enough
        const res = await request(app).get('/api/v1/roles').set('Authorization', `Bearer ${t}`);
        expect(res.status).toBe(403);
    });
});

describe('given role lifecycle operations when performed then guard rails hold', () => {

    test('given a valid code and name then the role is created empty and is not system', async () => {
        const res = await api().post('/', { code: CODE, name: 'Test Role', descr: 'e2e' });
        expect(res.status).toBe(201);
        expect(res.body.content.role).toMatchObject({
            code: CODE, name: 'Test Role', is_system: false, permissions: [],
        });
    });

    test('given a duplicate code then creation is rejected with 409', async () => {
        const res = await api().post('/', { code: CODE, name: 'Again' });
        expect(res.status).toBe(409);
    });

    test('given a malformed code then creation is rejected with 400', async () => {
        const res = await api().post('/', { code: 'Bad Code!', name: 'Nope' });
        expect(res.status).toBe(400);
    });

    test('given a rename then name and descr change but the code is immutable', async () => {
        const res = await api().put(`/${CODE}`, { name: 'Renamed Role', descr: 'updated' });
        expect(res.status).toBe(200);
        expect(res.body.content.role).toMatchObject({ code: CODE, name: 'Renamed Role', descr: 'updated' });
    });

    test('given a permission replace then holders resolve the new set via fn_user_permissions', async () => {
        const set1 = await api().put(`/${CODE}/permissions`, { permissions: ['orders:read', 'reports:view'] });
        expect(set1.status).toBe(200);
        expect(set1.body.content.permissions.sort()).toEqual(['orders:read', 'reports:view']);

        const holder = await Users.create({ email: `roles-holder-${RUN}@example.com`, role: CODE }, 1);
        expect((await Rbac.getPermissionsForUser(holder.id)).sort()).toEqual(['orders:read', 'reports:view']);

        const set2 = await api().put(`/${CODE}/permissions`, { permissions: ['orders:read'] });
        expect(set2.status).toBe(200);
        expect(await Rbac.getPermissionsForUser(holder.id)).toEqual(['orders:read']);
    });

    test('given unknown permission codes then the replace is rejected with 400 and nothing changes', async () => {
        const res = await api().put(`/${CODE}/permissions`, { permissions: ['orders:read', 'galaxy:rule'] });
        expect(res.status).toBe(400);
        const roles = await Rbac.listRoles();
        expect(roles.find(r => r.code === CODE).permissions).toEqual(['orders:read']);
    });

    test('given the locked admin role then permission edits and deletion are rejected with 403', async () => {
        const edit = await api().put('/admin/permissions', { permissions: ['orders:read'] });
        expect(edit.status).toBe(403);
        const del = await api().del('/admin');
        expect(del.status).toBe(403);
    });

    test('given the locked customer role then permission edits are rejected with 403', async () => {
        const res = await api().put('/customer/permissions', { permissions: [] });
        expect(res.status).toBe(403);
    });

    test('given an unlocked system role then permissions are editable but deletion is rejected', async () => {
        const before = (await Rbac.listRoles()).find(r => r.code === 'finance').permissions;

        const edit = await api().put('/finance/permissions', { permissions: before });
        expect(edit.status).toBe(200);   // no-op replace proves editability

        const del = await api().del('/finance');
        expect(del.status).toBe(403);
    });

    test('given a role still held by a user then deletion is rejected with 409', async () => {
        const res = await api().del(`/${CODE}`);   // holder created above still has it
        expect(res.status).toBe(409);
    });

    test('given an unheld custom role then deletion succeeds and is audited', async () => {
        const code = `${CODE}_tmp`;
        await api().post('/', { code, name: 'Ephemeral' });
        const res = await api().del(`/${code}`);
        expect(res.status).toBe(200);

        const audit = await db.query(
            `SELECT action, actor_user_id FROM audit_log
             WHERE entity = 'roles'
               AND (new_data->>'code' = $1 OR old_data->>'code' = $1)
             ORDER BY audit_no`,
            [code]
        );
        expect(audit.rows.map(r => r.action)).toEqual(['INSERT', 'DELETE']);
        // pg returns BIGINT as string — compare numerically
        expect(audit.rows.every(r => Number(r.actor_user_id) === Number(admin.id))).toBe(true);
    });

    test('given an unknown role then update, permission-replace and delete are 404', async () => {
        expect((await api().put('/nonexistent_role', { name: 'X' })).status).toBe(404);
        expect((await api().put('/nonexistent_role/permissions', { permissions: [] })).status).toBe(404);
        expect((await api().del('/nonexistent_role')).status).toBe(404);
    });
});
