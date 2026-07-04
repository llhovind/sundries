'use strict';

/**
 * bootstrap.js — one-time initial-admin setup for a fresh install.
 *
 * Creates the initial admin user from environment variables and grants the
 * admin role. Idempotent: exits cleanly when an active admin already exists.
 * Auth is passwordless (emailed OTP), so no password is ever seeded — the
 * admin logs in by requesting a login code at ADMIN_EMAIL.
 *
 * Required env: ADMIN_EMAIL
 * Optional env: ADMIN_USERNAME (default 'admin')
 *
 * Usage: node db/bootstrap.js   (or `npm run setup` = migrate + bootstrap)
 */

require('dotenv').config();
const { pool, withTransaction } = require('../common/db');

async function run() {
    const email    = process.env.ADMIN_EMAIL;
    const username = process.env.ADMIN_USERNAME || 'admin';

    if (!email) {
        console.error('ADMIN_EMAIL is required to bootstrap the initial admin user.');
        process.exit(1);
    }

    try {
        const existing = await pool.query(
            `SELECT id, email FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1`
        );
        if (existing.rows.length > 0) {
            console.log(`Admin already exists (${existing.rows[0].email}) — nothing to do.`);
            return;
        }

        const userId = await withTransaction(async (client) => {
            const res = await client.query(
                `INSERT INTO users (username, email, role, status)
                 VALUES ($1, $2, 'admin', 'active')
                 RETURNING id`,
                [username, email]
            );
            const id = res.rows[0].id;
            await client.query(
                `INSERT INTO user_roles (user_id, role_no, granted_by)
                 SELECT $1, role_no, $1 FROM roles WHERE code = 'admin'`,
                [id]
            );
            return id;
        });

        console.log(`Created initial admin user #${userId} (${email}).`);
        console.log('Log in by requesting an OTP code at that email address.');
    } finally {
        await pool.end();
    }
}

run().catch(err => {
    console.error('Bootstrap failed:', err.message);
    process.exit(1);
});
