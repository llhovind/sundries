'use strict';

const db = require('../common/db').DB;

const OTP_EXPIRY_MINUTES   = 10;
const RATE_LIMIT_WINDOW_MINUTES = 15;
const RATE_LIMIT_MAX_REQUESTS   = 3;
// Failed verifications allowed per code before it is dead. With 6-digit
// codes, 3 codes / 15 min and 5 guesses each, a brute-force attempt has a
// ~1-in-66,000 chance per window — and each locked code forces the
// rate-limited request-otp path again.
const MAX_VERIFY_ATTEMPTS = 5;

const OtpCodes = (function () {

    return {
        create,
        findValid,
        markUsed,
        recordFailedAttempt,
        countRecent,
        RATE_LIMIT_MAX_REQUESTS,
        RATE_LIMIT_WINDOW_MINUTES,
        OTP_EXPIRY_MINUTES,
        MAX_VERIFY_ATTEMPTS,
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
     * Return the most recent unused, non-expired OTP for a user that is not
     * locked out by failed attempts, or null.
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
               AND attempt_count < $2
             ORDER BY _create_ts DESC
             LIMIT 1`,
            [userId, MAX_VERIFY_ATTEMPTS]
        ).then(res => res.rows[0] || null);
    }

    /**
     * Record a failed verification against a code. The increment is a single
     * atomic UPDATE, so concurrent wrong guesses cannot lose counts.
     *
     * @param {number} id - primary key of the otp_codes row
     * @returns {Promise<number>} the new attempt count
     */
    function recordFailedAttempt(id) {
        return db.query(
            `UPDATE otp_codes SET attempt_count = attempt_count + 1
             WHERE id = $1
             RETURNING attempt_count`,
            [id]
        ).then(res => res.rows[0]?.attempt_count ?? 0);
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
