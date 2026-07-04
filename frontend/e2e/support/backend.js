import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * Backend-side helpers for e2e specs. Scripts run with node inside the
 * backend directory (its own deps + .env), piped via stdin so no shell
 * quoting is involved and the frontend gains no test-only dependencies.
 */

const backendDir = path.resolve(process.cwd(), '../backend');

function backendEval(script, env = {}) {
    const out = execSync('node', {
        input: script,
        cwd: backendDir,
        env: { ...process.env, ...env },
    });
    return out.toString().trim().split('\n').pop().trim();   // last line: ignore any banner output
}

/** Mint a staff access token with the backend's own JWT secret. */
export function staffToken(perms = ['catalog:write', 'inventory:read', 'inventory:receive']) {
    return backendEval(
        `require('dotenv').config({ quiet: true });
         const jwt = require('jsonwebtoken');
         console.log(jwt.sign(
             { sub: 1, email: 'e2e-staff@example.com', role: 'admin', roles: ['admin'],
               perms: JSON.parse(process.env.E2E_PERMS) },
             process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }));`,
        { E2E_PERMS: JSON.stringify(perms) }
    );
}

/**
 * Create an active customer and plant a known login code for them.
 * OTPs are stored hashed, so tests cannot read the emailed code — they
 * plant one instead. verify-otp uses the newest unused code, so call this
 * AFTER the UI has hit request-otp, or the real (unknown) code wins.
 */
export function plantLoginCode(email, code) {
    backendEval(
        `require('dotenv').config({ quiet: true });
         const crypto = require('crypto');
         const { DB: db, pool } = require('./common/db');
         (async () => {
             const u = await db.query(
                 "INSERT INTO users (email, role, status) VALUES ($1, 'customer', 'active') RETURNING id",
                 [process.env.E2E_EMAIL]);
             const hash = crypto.createHash('sha256').update(process.env.E2E_OTP).digest('hex');
             await db.query(
                 "INSERT INTO otp_codes (user_id, otp_hash, expires_at, _create_ts)" +
                 " VALUES ($1, $2, NOW() + interval '10 minutes', NOW())",
                 [u.rows[0].id, hash]);
             await pool.end();
         })().catch(e => { console.error(e.message); process.exit(1); });`,
        { E2E_EMAIL: email, E2E_OTP: code }
    );
}

/**
 * Drive the login page through the email step, then plant `code` as the
 * valid login code. The caller fills #otp and submits (with the planted
 * code to log in, or a wrong one to test rejection).
 */
export async function beginOtpLogin(page, email, code) {
    await page.goto('/login');
    await page.fill('#email', email);
    const otpRequested = page.waitForResponse(r => r.url().includes('/api/v1/auth/request-otp'));
    await page.click('button[type="submit"]');
    await otpRequested;
    plantLoginCode(email, code);
}
