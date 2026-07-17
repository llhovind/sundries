'use strict';

const { DB: db, withAudit } = require('../common/db');
const { requireString, optionalString, requireNumber, oneOf } = require('../common/validation');

/**
 * Tax rate table for the 'local' tax provider (services/taxService.js —
 * most specific active row wins: country+state beats country-wide).
 *
 * `rate` is a FRACTION (0.0825 = 8.25%); the <= 1 bound exists to catch the
 * classic "8.25" typo, which would multiply every order's tax by a hundred.
 * Rows are disabled via status, never deleted.
 */
const TaxRates = (function () {

    const STATUSES = ['active', 'inactive'];

    return { findAll, create, update };

    function findAll() {
        return db.query(
            `SELECT rate_no, country, state, postal_prefix, rate, name, status, _modify_ts
             FROM tax_rates ORDER BY country, state NULLS FIRST, postal_prefix NULLS FIRST`
        ).then(res => res.rows);
    }

    function validate(data) {
        const state = optionalString(data.state, 'state');
        return {
            country:       requireString(data.country, 'country').toUpperCase(),
            state:         state ? state.toUpperCase() : null,
            postal_prefix: optionalString(data.postal_prefix, 'postal_prefix'),
            rate:          requireNumber(data.rate, 'rate (a fraction, e.g. 0.0825 for 8.25%)', { min: 0, max: 1 }),
            name:          requireString(data.name, 'name'),
            status:        oneOf(data.status ?? 'active', 'status', STATUSES),
        };
    }

    function create(data, userId) {
        const t = validate(data);
        return withAudit(userId, (client) => client.query(
            `INSERT INTO tax_rates (country, state, postal_prefix, rate, name, status,
                                    _create_ts, _modify_ts, _modify_user_id)
             VALUES ($1,$2,$3,$4,$5,$6, NOW(), NOW(), $7)
             RETURNING rate_no, country, state, postal_prefix, rate, name, status, _modify_ts`,
            [t.country, t.state, t.postal_prefix, t.rate, t.name, t.status, userId]
        )).then(res => res.rows[0]);
    }

    function update(rateNo, data, userId) {
        const t = validate(data);
        return withAudit(userId, (client) => client.query(
            `UPDATE tax_rates
             SET country=$2, state=$3, postal_prefix=$4, rate=$5, name=$6, status=$7,
                 _modify_ts=NOW(), _modify_user_id=$8
             WHERE rate_no=$1
             RETURNING rate_no, country, state, postal_prefix, rate, name, status, _modify_ts`,
            [rateNo, t.country, t.state, t.postal_prefix, t.rate, t.name, t.status, userId]
        )).then(res => res.rows[0] || null);
    }

}());

module.exports = TaxRates;
