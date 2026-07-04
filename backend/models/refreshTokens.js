const crypto = require('crypto');
const db = require('../common/db').DB;

const RefreshTokens = (function () {

    return {
        create,
        findByToken,
        revoke,
        revokeAllForUser
    };

    function hashToken(token) {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    function create(userId, token, expiresAt) {
        const tokenHash = hashToken(token);
        return db.query(
            `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, _create_ts)
             VALUES ($1, $2, $3, NOW())
             RETURNING id`,
            [userId, tokenHash, expiresAt]
        ).then(res => res.rows[0]);
    }

    function findByToken(token) {
        const tokenHash = hashToken(token);
        return db.query(
            `SELECT rt.id, rt.expires_at, rt.revoked_at, rt._create_ts,
                    u.id AS user_id, u.username, u.email, u.role, u.status
             FROM refresh_tokens rt
             JOIN users u ON u.id = rt.user_id
             WHERE rt.token_hash = $1
               AND rt.revoked_at IS NULL
               AND rt.expires_at > NOW()`,
            [tokenHash]
        ).then(res => res.rows[0] || null);
    }

    function revoke(token) {
        const tokenHash = hashToken(token);
        return db.query(
            'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1',
            [tokenHash]
        );
    }

    function revokeAllForUser(userId) {
        return db.query(
            'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
            [userId]
        );
    }

}());

module.exports = RefreshTokens;
