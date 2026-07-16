'use strict';

const { DB: db, withTransaction } = require('../common/db');

/**
 * Repository for role/permission resolution and role grants.
 *
 * Permission resolution delegates to fn_user_permissions(), which unions the
 * user_roles grants with the legacy users.role column during the transition.
 * Grant/revoke set the per-transaction app.user_id setting so the DB audit
 * trigger on user_roles records the acting user.
 */
const Rbac = (function () {

    // Roles whose permission set and existence are not editable through the
    // API: admin must always retain full access (including users:manage and
    // roles:manage — the escape hatch), and customer defines the storefront
    // baseline that registration depends on.
    const LOCKED_ROLES = Object.freeze(['admin', 'customer']);

    // New roles get machine-friendly codes: lowercase, digits, underscores.
    const ROLE_CODE_REGEX = /^[a-z][a-z0-9_]{1,49}$/;

    return {
        LOCKED_ROLES,
        ROLE_CODE_REGEX,
        getPermissionsForUser,
        getRolesForUser,
        listRoles,
        listPermissions,
        createRole,
        updateRole,
        setRolePermissions,
        deleteRole,
        grantRole,
        revokeRole,
        findUsersWithPermission,
    };

    /**
     * Active users holding a permission — notification routing (e.g. email
     * everyone who can fulfill orders when one lands).
     *
     * @returns {Promise<Array<{id:number, email:string}>>}
     */
    function findUsersWithPermission(permCode) {
        return db.query(
            `SELECT DISTINCT u.id, u.email
             FROM users u
             JOIN user_roles ur       ON ur.user_id = u.id
             JOIN role_permissions rp ON rp.role_no = ur.role_no
             JOIN permissions p       ON p.perm_no = rp.perm_no
             WHERE p.code = $1 AND u.status = 'active'`,
            [permCode]
        ).then(res => res.rows);
    }

    /**
     * @param {number} userId
     * @returns {Promise<string[]>} permission codes, e.g. ['orders:read', ...]
     */
    function getPermissionsForUser(userId) {
        return db.query('SELECT code FROM fn_user_permissions($1)', [userId])
            .then(res => res.rows.map(r => r.code));
    }

    /**
     * @param {number} userId
     * @returns {Promise<string[]>} role codes, e.g. ['finance', 'fulfillment']
     */
    function getRolesForUser(userId) {
        return db.query(
            `SELECT r.code
             FROM user_roles ur
             JOIN roles r ON r.role_no = ur.role_no
             WHERE ur.user_id = $1
             ORDER BY r.code`,
            [userId]
        ).then(res => res.rows.map(r => r.code));
    }

    /**
     * All roles with their permission codes and holder counts — feeds the
     * admin users UI and the roles editor.
     */
    function listRoles() {
        return db.query(
            `SELECT r.role_no, r.code, r.name, r.descr, r.is_system,
                    COALESCE(ARRAY_AGG(p.code ORDER BY p.code)
                             FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions,
                    (SELECT COUNT(*)::int FROM user_roles ur
                     WHERE ur.role_no = r.role_no) AS user_count
             FROM roles r
             LEFT JOIN role_permissions rp ON rp.role_no = r.role_no
             LEFT JOIN permissions p       ON p.perm_no = rp.perm_no
             GROUP BY r.role_no
             ORDER BY r.code`
        ).then(res => res.rows);
    }

    /**
     * The permission catalog. Read-only by design: permission codes are
     * defined in code/migrations and mapped to endpoints in
     * config/routePermissions — there is deliberately no API to change them.
     */
    function listPermissions() {
        return db.query('SELECT perm_no, code, descr FROM permissions ORDER BY code')
            .then(res => res.rows);
    }

    /** Throws a status-tagged error, matching the grantRole convention. */
    function reject(status, message) {
        throw Object.assign(new Error(message), { status });
    }

    /**
     * Creates a custom (non-system) role with no permissions. Permissions are
     * assigned separately via setRolePermissions.
     */
    function createRole({ code, name, descr = null }, actorId) {
        if (!ROLE_CODE_REGEX.test(code || '')) {
            reject(400, 'Role code must be 2-50 chars: lowercase letters, digits, underscores');
        }
        if (!name) reject(400, 'Role name is required');

        return withTransaction(async (client) => {
            await client.query(`SELECT set_config('app.user_id', $1, true)`, [String(actorId)]);
            const res = await client.query(
                `INSERT INTO roles (code, name, descr, is_system)
                 VALUES ($1, $2, $3, FALSE)
                 ON CONFLICT (code) DO NOTHING
                 RETURNING role_no, code, name, descr, is_system`,
                [code, name, descr]
            );
            if (res.rowCount === 0) reject(409, `Role already exists: ${code}`);
            return { ...res.rows[0], permissions: [], user_count: 0 };
        });
    }

    /**
     * Renames a role (name/descr only — the code is an immutable identifier
     * referenced by users.role, JWTs, and the frontend router).
     */
    function updateRole(code, { name, descr }, actorId) {
        if (name !== undefined && !name) reject(400, 'Role name cannot be empty');
        if (name === undefined && descr === undefined) reject(400, 'Nothing to update');

        return withTransaction(async (client) => {
            await client.query(`SELECT set_config('app.user_id', $1, true)`, [String(actorId)]);
            const sets = [];
            const vals = [];
            if (name !== undefined)  { vals.push(name);  sets.push(`name = $${vals.length}`); }
            if (descr !== undefined) { vals.push(descr); sets.push(`descr = $${vals.length}`); }
            vals.push(code);

            const res = await client.query(
                `UPDATE roles SET ${sets.join(', ')} WHERE code = $${vals.length}
                 RETURNING role_no, code, name, descr, is_system`,
                vals
            );
            if (res.rowCount === 0) reject(404, `Unknown role: ${code}`);
            return res.rows[0];
        });
    }

    /**
     * Replaces a role's permission set atomically. Rejects unknown permission
     * codes and locked roles (admin must keep full access; customer defines
     * the storefront baseline).
     *
     * Takes effect for each holder on their next token refresh — permissions
     * are embedded in access tokens at issue time.
     *
     * @returns {Promise<string[]>} the new permission codes
     */
    function setRolePermissions(code, permCodes, actorId) {
        if (!Array.isArray(permCodes)) reject(400, 'permissions must be an array of codes');
        if (LOCKED_ROLES.includes(code)) reject(403, `Role is locked: ${code}`);

        return withTransaction(async (client) => {
            await client.query(`SELECT set_config('app.user_id', $1, true)`, [String(actorId)]);

            const role = await client.query('SELECT role_no FROM roles WHERE code = $1', [code]);
            if (role.rowCount === 0) reject(404, `Unknown role: ${code}`);
            const roleNo = role.rows[0].role_no;

            const perms = await client.query(
                'SELECT perm_no, code FROM permissions WHERE code = ANY($1)',
                [permCodes]
            );
            if (perms.rowCount !== new Set(permCodes).size) {
                const known   = perms.rows.map(p => p.code);
                const unknown = permCodes.filter(c => !known.includes(c));
                reject(400, `Unknown permissions: ${unknown.join(', ')}`);
            }

            await client.query('DELETE FROM role_permissions WHERE role_no = $1', [roleNo]);
            if (perms.rowCount > 0) {
                await client.query(
                    `INSERT INTO role_permissions (role_no, perm_no)
                     SELECT $1, perm_no FROM permissions WHERE code = ANY($2)`,
                    [roleNo, permCodes]
                );
            }
            return perms.rows.map(p => p.code).sort();
        });
    }

    /**
     * Deletes a custom role. System roles and roles still held by any user
     * (primary or granted) are protected.
     */
    function deleteRole(code, actorId) {
        if (LOCKED_ROLES.includes(code)) reject(403, `Role is locked: ${code}`);

        return withTransaction(async (client) => {
            await client.query(`SELECT set_config('app.user_id', $1, true)`, [String(actorId)]);

            const role = await client.query(
                'SELECT role_no, is_system FROM roles WHERE code = $1', [code]
            );
            if (role.rowCount === 0) reject(404, `Unknown role: ${code}`);
            if (role.rows[0].is_system) reject(403, `System roles cannot be deleted: ${code}`);

            const held = await client.query(
                `SELECT (SELECT COUNT(*) FROM user_roles WHERE role_no = $1)
                      + (SELECT COUNT(*) FROM users WHERE role = $2) AS n`,
                [role.rows[0].role_no, code]
            );
            if (Number(held.rows[0].n) > 0) {
                reject(409, `Role is still assigned to users: ${code}`);
            }

            await client.query('DELETE FROM roles WHERE role_no = $1', [role.rows[0].role_no]);
            return true;
        });
    }

    /**
     * Grants a role to a user. Idempotent. The audit_log row records grantedBy
     * via the app.user_id transaction setting.
     *
     * @returns {Promise<boolean>} true if newly granted, false if already held
     */
    function grantRole(userId, roleCode, grantedBy) {
        return withTransaction(async (client) => {
            await client.query(`SELECT set_config('app.user_id', $1, true)`, [String(grantedBy)]);
            const res = await client.query(
                `INSERT INTO user_roles (user_id, role_no, granted_by)
                 SELECT $1, role_no, $3 FROM roles WHERE code = $2
                 ON CONFLICT (user_id, role_no) DO NOTHING
                 RETURNING role_no`,
                [userId, roleCode, grantedBy]
            );
            if (res.rowCount === 0) {
                // Distinguish "already granted" from "no such role"
                const role = await client.query('SELECT 1 FROM roles WHERE code = $1', [roleCode]);
                if (role.rowCount === 0) {
                    throw Object.assign(new Error(`Unknown role: ${roleCode}`), { status: 400 });
                }
                return false;
            }
            return true;
        });
    }

    /**
     * Revokes a role from a user.
     *
     * @returns {Promise<boolean>} true if a grant was removed
     */
    function revokeRole(userId, roleCode, revokedBy) {
        return withTransaction(async (client) => {
            await client.query(`SELECT set_config('app.user_id', $1, true)`, [String(revokedBy)]);
            const res = await client.query(
                `DELETE FROM user_roles ur
                 USING roles r
                 WHERE ur.role_no = r.role_no AND ur.user_id = $1 AND r.code = $2
                 RETURNING ur.role_no`,
                [userId, roleCode]
            );
            return res.rowCount > 0;
        });
    }

}());

module.exports = Rbac;
