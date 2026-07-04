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

    return {
        getPermissionsForUser,
        getRolesForUser,
        listRoles,
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
     * All roles with their permission codes — feeds the admin users UI.
     */
    function listRoles() {
        return db.query(
            `SELECT r.role_no, r.code, r.name, r.descr, r.is_system,
                    COALESCE(ARRAY_AGG(p.code ORDER BY p.code)
                             FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
             FROM roles r
             LEFT JOIN role_permissions rp ON rp.role_no = r.role_no
             LEFT JOIN permissions p       ON p.perm_no = rp.perm_no
             GROUP BY r.role_no
             ORDER BY r.code`
        ).then(res => res.rows);
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
