'use strict';

const crypto = require('crypto');
const { DB: db, withTransaction } = require('../common/db');

/**
 * Refresh tokens with rotation (see migration 010).
 *
 * Lifecycle: a login creates a token in a fresh family. Every refresh claims
 * the presented token (revokes it) and issues a successor in the same family,
 * so a stolen-then-used token always collides with the legitimate client.
 * A dead token presented again within REUSE_GRACE_SECONDS of its rotation is
 * treated as a benign replay (parallel tabs refreshing at once) and gets its
 * own successor; outside that window the family is assumed compromised and
 * every live token in it is revoked.
 *
 * Only SHA-256 hashes are stored — a DB leak exposes no usable tokens.
 */
const RefreshTokens = (function () {

    const REUSE_GRACE_SECONDS = 30;

    // Dead rows are kept for incident forensics, then removed by the daily
    // auth-token-purge job. Rotation writes one row per refresh, so without
    // the purge the table grows without bound.
    const PURGE_RETENTION_DAYS = 30;

    return {
        create,
        rotate,
        revokeFamily,
        revokeAllForUser,
        purgeExpired,
        REUSE_GRACE_SECONDS,
        PURGE_RETENTION_DAYS,
    };

    function hashToken(token) {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    /** Store a login's first token; the DB assigns it a fresh family. */
    function create(userId, token, expiresAt) {
        const tokenHash = hashToken(token);
        return db.query(
            `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, _create_ts)
             VALUES ($1, $2, $3, NOW())
             RETURNING id, family_id`,
            [userId, tokenHash, expiresAt]
        ).then(res => res.rows[0]);
    }

    /**
     * Exchange oldToken for newToken atomically.
     *
     * @returns {Promise<
     *   {outcome:'rotated', user:{id,username,email,role,status}} |
     *   {outcome:'reused', userId:number, familyId:string} |
     *   {outcome:'unknown'} | {outcome:'expired'}
     * >}
     */
    function rotate(oldToken, newToken, expiresAt) {
        const oldHash = hashToken(oldToken);
        const newHash = hashToken(newToken);

        return withTransaction(async (client) => {
            // Atomic claim: only one concurrent request can revoke a live
            // token; losers of the race fall through to diagnosis below.
            const claimed = await client.query(
                `UPDATE refresh_tokens
                 SET revoked_at = NOW()
                 WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
                 RETURNING id, user_id, family_id`,
                [oldHash]
            );

            if (claimed.rows.length) {
                const old = claimed.rows[0];
                const ins = await client.query(
                    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, _create_ts)
                     VALUES ($1, $2, $3, $4, NOW())
                     RETURNING id`,
                    [old.user_id, old.family_id, newHash, expiresAt]
                );
                await client.query(
                    `UPDATE refresh_tokens SET replaced_by = $2 WHERE id = $1`,
                    [old.id, ins.rows[0].id]
                );
                return { outcome: 'rotated', user: await userFor(client, old.user_id) };
            }

            // The token could not be claimed — find out why.
            const found = await client.query(
                `SELECT rt.id, rt.user_id, rt.family_id, rt.revoked_at, rt.replaced_by,
                        succ.revoked_at AS successor_revoked_at
                 FROM refresh_tokens rt
                 LEFT JOIN refresh_tokens succ ON succ.id = rt.replaced_by
                 WHERE rt.token_hash = $1`,
                [oldHash]
            );
            if (!found.rows.length) return { outcome: 'unknown' };

            const row = found.rows[0];
            if (row.revoked_at === null) return { outcome: 'expired' };

            // Benign replay: the token was rotated moments ago and its
            // successor is still live (a logout or reuse detection would have
            // revoked it) — parallel tabs refreshed with the same cookie.
            const withinGrace =
                Date.now() - new Date(row.revoked_at).getTime() < REUSE_GRACE_SECONDS * 1000;
            if (row.replaced_by !== null && row.successor_revoked_at === null && withinGrace) {
                await client.query(
                    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, _create_ts)
                     VALUES ($1, $2, $3, $4, NOW())`,
                    [row.user_id, row.family_id, newHash, expiresAt]
                );
                return { outcome: 'rotated', user: await userFor(client, row.user_id) };
            }

            // A dead token came back outside the grace window: assume it
            // leaked and revoke every live token in the family.
            await client.query(
                `UPDATE refresh_tokens SET revoked_at = NOW()
                 WHERE family_id = $1 AND revoked_at IS NULL`,
                [row.family_id]
            );
            return { outcome: 'reused', userId: row.user_id, familyId: row.family_id };
        });
    }

    function userFor(client, userId) {
        return client.query(
            `SELECT id, username, email, role, status FROM users WHERE id = $1`,
            [userId]
        ).then(res => res.rows[0]);
    }

    /** Revoke every live token in the presented token's family (logout). */
    function revokeFamily(token) {
        const tokenHash = hashToken(token);
        return db.query(
            `UPDATE refresh_tokens SET revoked_at = NOW()
             WHERE revoked_at IS NULL
               AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
            [tokenHash]
        );
    }

    function revokeAllForUser(userId) {
        return db.query(
            'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
            [userId]
        );
    }

    /** Remove rows dead longer than the forensic retention window. */
    function purgeExpired() {
        return db.query(
            `DELETE FROM refresh_tokens
             WHERE expires_at < NOW() - make_interval(days => $1)`,
            [PURGE_RETENTION_DAYS]
        ).then(res => ({ purged: res.rowCount }));
    }

}());

module.exports = RefreshTokens;
