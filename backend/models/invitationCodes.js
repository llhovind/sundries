'use strict';

const db = require('../common/db').DB;

const InvitationCodes = (function () {

    return {
        findByCode,
    };

    /**
     * Look up an invitation code by its plaintext value.
     *
     * @param {string} code
     * @returns {Promise<object|null>} row with { id, code, label, expires_at, max_uses, use_count }
     */
    function findByCode(code) {
        return db.query(
            `SELECT id, code, label, expires_at, max_uses, use_count
             FROM invitation_codes
             WHERE code = $1`,
            [code]
        ).then(res => res.rows[0] || null);
    }

}());

module.exports = InvitationCodes;
