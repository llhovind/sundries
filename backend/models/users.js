'use strict';

const db = require('../common/db').DB;
const { withTransaction } = require('../common/db');

const Users = (function () {

    return {
        findByUsername,
        findByEmail,
        findById,
        findAdminUser,
        findAll,
        create,
        update,
        deactivate,
    };

    function findAll({ search, limit = 25, offset = 0 } = {}) {
        const params = [];
        let where = '';
        if (search) {
            params.push(`%${search}%`);
            where = `WHERE username ILIKE $1 OR email ILIKE $1`;
        }
        const pOffset = params.length + 1;
        const pLimit  = params.length + 2;
        params.push(offset, limit);

        return db.query(
            `SELECT id, username, email, role, status, _create_ts,
                    COUNT(*) OVER() AS _total
             FROM users ${where}
             ORDER BY lower(email) OFFSET $${pOffset} LIMIT $${pLimit}`,
            params
        ).then(res => ({
            total: res.rows.length > 0 ? +res.rows[0]._total : 0,
            users: res.rows.map(({ _total, ...u }) => u),
        }));
    }

    /**
     * Returns any active admin user (used for notification routing).
     * @returns {Promise<object|null>}
     */
    function findAdminUser() {
        return db.query(
            `SELECT id, username, email FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1`
        ).then(res => res.rows[0] || null);
    }

    /**
     * Look up a user by username (case-insensitive). Retained for backward
     * compatibility with seeded data; prefer findByEmail for auth flows.
     *
     * @param {string} username
     * @returns {Promise<object|null>}
     */
    function findByUsername(username) {
        return db.query(
            `SELECT id, username, email, role, status
             FROM users WHERE lower(username) = lower($1)`,
            [username]
        ).then(res => res.rows[0] || null);
    }

    /**
     * Look up a user by email address (case-insensitive).
     * This is the primary auth identifier in the OTP system.
     *
     * @param {string} email
     * @returns {Promise<object|null>}
     */
    function findByEmail(email) {
        return db.query(
            `SELECT id, username, email, role, status
             FROM users WHERE lower(email) = lower($1)`,
            [email]
        ).then(res => res.rows[0] || null);
    }

    function findById(id) {
        return db.query(
            'SELECT id, username, email, role, status FROM users WHERE id = $1',
            [id]
        ).then(res => res.rows[0] || null);
    }

    /**
     * Updates a user's primary role and/or status.
     *
     * Setting the primary role RESETS user_roles to exactly that role, in the
     * same transaction — otherwise a demoted user would keep their old
     * permissions through stale grants. Additional roles are granted
     * afterwards via the role-grant endpoints.
     *
     * @param {number} id
     * @param {{role?: string, status?: string}} changes
     * @param {number} actorId - recorded by the user_roles audit trigger
     */
    async function update(id, { role, status }, actorId) {
        const allowedStatus = ['active', 'inactive'];

        if (status !== undefined && !allowedStatus.includes(status)) {
            throw new Error('Invalid status');
        }
        if (role === undefined && status === undefined) {
            throw new Error('Nothing to update');
        }
        if (role !== undefined) {
            // Valid roles live in the roles table (seeded + admin-defined), not
            // a hardcoded list. users.role carries an FK too, but validating
            // here returns a clean 400 instead of a constraint 500.
            const known = await db.query('SELECT 1 FROM roles WHERE code = $1', [role]);
            if (known.rowCount === 0) throw new Error('Invalid role');
        }

        return withTransaction(async (client) => {
            if (actorId != null) {
                await client.query(`SELECT set_config('app.user_id', $1, true)`, [String(actorId)]);
            }
            const sets = ['_modify_ts = NOW()'];
            const vals = [];
            if (role !== undefined)   { vals.push(role);   sets.push(`role = $${vals.length}`); }
            if (status !== undefined) { vals.push(status); sets.push(`status = $${vals.length}`); }
            vals.push(id);

            const res = await client.query(
                `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}
                 RETURNING id, username, email, role, status`,
                vals
            );
            const user = res.rows[0] || null;

            if (user && role !== undefined) {
                await client.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
                await client.query(
                    `INSERT INTO user_roles (user_id, role_no, granted_by)
                     SELECT $1, role_no, $3 FROM roles WHERE code = $2`,
                    [id, role, actorId ?? null]
                );
            }
            return user;
        });
    }

    function deactivate(id) {
        return db.query(
            `UPDATE users SET status = 'inactive', _modify_ts = NOW()
             WHERE id = $1 RETURNING id, username, email, role, status`,
            [id]
        ).then(res => res.rows[0] || null);
    }

    /**
     * Create a new user. Password hash is no longer required — OTP is the
     * sole authentication method. username is an optional display name.
     *
     * @param {object} params
     * @param {string}  params.email       - required; primary auth identifier
     * @param {string}  [params.role]      - 'admin' | 'customer' (default: 'customer')
     * @param {string}  [params.username]  - optional display name
     * @returns {Promise<object>}
     */
    async function create({ email, role = 'customer', username = null }, actorId) {
        const known = await db.query('SELECT 1 FROM roles WHERE code = $1', [role]);
        if (known.rowCount === 0) throw new Error('Invalid role');

        return withTransaction(async (client) => {
            if (actorId != null) {
                await client.query(`SELECT set_config('app.user_id', $1, true)`, [String(actorId)]);
            }
            const res = await client.query(
                `INSERT INTO users (username, email, role, status, _create_ts, _modify_ts)
                 VALUES ($1, $2, $3, 'active', NOW(), NOW())
                 RETURNING id, username, email, role, status`,
                [username, email, role]
            );
            const user = res.rows[0];
            await client.query(
                `INSERT INTO user_roles (user_id, role_no, granted_by)
                 SELECT $1, role_no, $3 FROM roles WHERE code = $2`,
                [user.id, role, actorId ?? null]
            );
            return user;
        });
    }

}());

module.exports = Users;
