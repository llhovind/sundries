'use strict';

const db = require('../common/db').DB;

const OTP_EXPIRY_MINUTES   = 10;
const RATE_LIMIT_WINDOW_MINUTES = 15;
const RATE_LIMIT_MAX_REQUESTS   = 3;

const OtpCodes = (function () {

    return {
        create,
        findValid,
        markUsed,
        countRecent,
        RATE_LIMIT_MAX_REQUESTS,
        RATE_LIMIT_WINDOW_MINUTES,
        OTP_EXPIRY_MINUTES,
    };

    /**
     * Persist a new OTP record.
     *
     * @param {number} userId   - owner of this OTP
     * @param {string} otpHash  - SHA-256 hex digest of the plaintext OTP
     * @returns {Promise<object>} - inserted row
     */
    function create(userId, otpHash) {
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
        return db.query(
            `INSERT INTO otp_codes (user_id, otp_hash, expires_at, _create_ts)
             VALUES ($1, $2, $3, NOW())
             RETURNING id, user_id, expires_at`,
            [userId, otpHash, expiresAt]
        ).then(res => res.rows[0]);
    }

    /**
     * Return the most recent unused, non-expired OTP for a user, or null.
     *
     * @param {number} userId
     * @returns {Promise<object|null>}
     */
    function findValid(userId) {
        return db.query(
            `SELECT id, user_id, otp_hash, expires_at
             FROM otp_codes
             WHERE user_id = $1
               AND used_at IS NULL
               AND expires_at > NOW()
             ORDER BY _create_ts DESC
             LIMIT 1`,
            [userId]
        ).then(res => res.rows[0] || null);
    }

    /**
     * Mark an OTP as consumed.
     *
     * @param {number} id - primary key of the otp_codes row
     * @returns {Promise<void>}
     */
    function markUsed(id) {
        return db.query(
            `UPDATE otp_codes SET used_at = NOW() WHERE id = $1`,
            [id]
        ).then(() => undefined);
    }

    /**
     * Count OTP requests issued to a user within the rate-limit window.
     * Used to enforce max 3 requests per 15 minutes.
     *
     * @param {number} userId
     * @returns {Promise<number>}
     */
    function countRecent(userId) {
        const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000);
        return db.query(
            `SELECT COUNT(*) FROM otp_codes
             WHERE user_id = $1 AND _create_ts > $2`,
            [userId, windowStart]
        ).then(res => +res.rows[0].count);
    }

}());

module.exports = OtpCodes;
