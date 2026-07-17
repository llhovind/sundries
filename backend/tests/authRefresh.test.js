'use strict';

/**
 * Refresh-token rotation integration tests — full Route→Model→DB path.
 *
 * Time-sensitive states (grace expiry, token expiry) are produced by
 * backdating rows directly, never by sleeping.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const crypto  = require('crypto');
const request = require('supertest');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');
const Users         = require('../models/users');
const OtpCodes      = require('../models/otpCodes');
const RefreshTokens = require('../models/refreshTokens');

const RUN = Date.now();
const OTP = '123456';
const COOKIE_NAME = 'refresh_token';

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

/** Extract the refresh cookie from a response; null when not set. */
function refreshCookie(res) {
    const header = res.headers['set-cookie'] || [];
    const raw = header.find(c => c.startsWith(`${COOKIE_NAME}=`));
    if (!raw) return null;
    const value = raw.split(';')[0].slice(COOKIE_NAME.length + 1);
    return { value, pair: `${COOKIE_NAME}=${value}` };
}

/** Create a fresh customer and complete an OTP login; returns user + cookie. */
async function login(tag) {
    const email = `authrot-${tag}-${RUN}@example.com`;
    const user  = await Users.create({ email, role: 'customer' }, 1);
    await OtpCodes.create(user.id, sha256Hex(OTP));

    const res = await request(app).post('/api/v1/auth/verify-otp').send({ email, otp: OTP });
    expect(res.status).toBe(200);

    const cookie = refreshCookie(res);
    expect(cookie).not.toBeNull();
    return { user, cookie };
}

function refreshWith(cookie) {
    return request(app).post('/api/v1/auth/refresh').set('Cookie', cookie.pair);
}

/** Backdate a token's rotation moment so it falls outside the grace window. */
function backdateRevocation(cookie, seconds) {
    return db.query(
        `UPDATE refresh_tokens SET revoked_at = NOW() - make_interval(secs => $2)
         WHERE token_hash = $1`,
        [sha256Hex(cookie.value), seconds]
    );
}

afterAll(async () => {
    await db.query(`DELETE FROM users WHERE email LIKE $1`, [`authrot-%-${RUN}@example.com`]);
    await pool.end();
});

describe('given a valid session when refreshing then the token rotates', () => {

    test('given a fresh login when refreshing then a different cookie and an access token are issued', async () => {
        const { cookie } = await login('rotate');

        const res = await refreshWith(cookie);
        expect(res.status).toBe(200);
        expect(res.body.accessToken).toBeTruthy();

        const next = refreshCookie(res);
        expect(next).not.toBeNull();
        expect(next.value).not.toBe(cookie.value);
    });

    test('given a rotated token when its successor is used then refresh keeps working', async () => {
        const { cookie } = await login('chain');
        const second = refreshCookie(await refreshWith(cookie));
        const res = await refreshWith(second);
        expect(res.status).toBe(200);
        expect(refreshCookie(res).value).not.toBe(second.value);
    });
});

describe('given token replay when inside the grace window then parallel tabs survive', () => {

    test('given a just-rotated token when replayed immediately then a new session token is still issued', async () => {
        const { cookie } = await login('grace');
        await refreshWith(cookie);                       // rotates: cookie is now dead

        const replay = await refreshWith(cookie);        // second tab, same old cookie
        expect(replay.status).toBe(200);
        expect(refreshCookie(replay).value).not.toBe(cookie.value);
    });
});

describe('given token reuse after the grace window then the family is revoked', () => {

    test('given a stale rotated token when replayed then 401 and every descendant dies too', async () => {
        const { cookie } = await login('reuse');
        const successor = refreshCookie(await refreshWith(cookie));

        await backdateRevocation(cookie, RefreshTokens.REUSE_GRACE_SECONDS + 1);

        const replay = await refreshWith(cookie);
        expect(replay.status).toBe(401);

        // Reuse detection must have killed the live successor as well.
        const res = await refreshWith(successor);
        expect(res.status).toBe(401);
    });
});

describe('given logout then no token in the family works again', () => {

    test('given a logged-out session when refreshing with the last cookie then 401', async () => {
        const { cookie } = await login('logout');
        const current = refreshCookie(await refreshWith(cookie));

        const out = await request(app).post('/api/v1/auth/logout').set('Cookie', current.pair);
        expect(out.status).toBe(200);

        expect((await refreshWith(current)).status).toBe(401);
    });

    test('given a logged-out session when replaying a pre-logout cookie within grace then 401', async () => {
        const { cookie } = await login('logout-replay');
        const current = refreshCookie(await refreshWith(cookie));
        await request(app).post('/api/v1/auth/logout').set('Cookie', current.pair);

        // cookie was rotated seconds ago (inside grace), but logout revoked
        // its successor — the grace path must not resurrect the session.
        expect((await refreshWith(cookie)).status).toBe(401);
    });
});

describe('given dead or foreign tokens when refreshing then they are rejected', () => {

    test('given an expired token when refreshing then 401', async () => {
        const { cookie } = await login('expired');
        await db.query(
            `UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 minute'
             WHERE token_hash = $1`,
            [sha256Hex(cookie.value)]
        );
        expect((await refreshWith(cookie)).status).toBe(401);
    });

    test('given a token the server never issued when refreshing then 401', async () => {
        const res = await refreshWith({ pair: `${COOKIE_NAME}=${'0'.repeat(80)}` });
        expect(res.status).toBe(401);
    });

    test('given a deactivated user when refreshing then 403 and their tokens are revoked', async () => {
        const { user, cookie } = await login('inactive');
        await db.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [user.id]);

        expect((await refreshWith(cookie)).status).toBe(403);

        const live = await db.query(
            `SELECT COUNT(*)::int AS n FROM refresh_tokens
             WHERE user_id = $1 AND revoked_at IS NULL`,
            [user.id]
        );
        expect(live.rows[0].n).toBe(0);
    });
});

describe('given the retention purge when run then only forensically stale rows are removed', () => {

    test('given tokens beyond and within retention when purging then only the stale one is deleted', async () => {
        const { user, cookie } = await login('purge');
        await db.query(
            `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, _create_ts)
             VALUES ($1, $2, NOW() - make_interval(days => $3 + 1), NOW())`,
            [user.id, sha256Hex(`stale-${RUN}`), RefreshTokens.PURGE_RETENTION_DAYS]
        );

        const { purged } = await RefreshTokens.purgeExpired();
        expect(purged).toBeGreaterThanOrEqual(1);

        const stale = await db.query(
            `SELECT 1 FROM refresh_tokens WHERE token_hash = $1`, [sha256Hex(`stale-${RUN}`)]
        );
        expect(stale.rows.length).toBe(0);

        // The live session survives the purge.
        expect((await refreshWith(cookie)).status).toBe(200);
    });
});
