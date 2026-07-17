'use strict';

const { DB: db } = require('../common/db');
const { requireString, optionalString, requireNumber, oneOf } = require('../common/validation');

/**
 * Warehouse administration. Reservation allocation walks ACTIVE standard
 * warehouses in priority order (lowest first); 'transport' warehouses are
 * virtual locations for in-transit stock transfers.
 *
 * `code` is the operational identifier (ledger UI, transfer forms) and is
 * immutable after creation, like role codes. Deactivation is a soft switch:
 * existing stock stays on the ledger and remains transferable out, but the
 * allocator stops sourcing new reservations from it.
 */
const Warehouses = (function () {

    const STATUSES = ['active', 'inactive'];
    const TYPES    = ['standard', 'transport'];

    return { findAll, create, update };

    function findAll() {
        return db.query(
            `SELECT warehouse_no, code, name, wh_type, address, city, state, country, zip,
                    priority, default_carrier, status, _modify_ts
             FROM warehouses ORDER BY priority, code`
        ).then(res => res.rows);
    }

    function validate(data, { withCode }) {
        const w = {
            name:            requireString(data.name, 'name'),
            wh_type:         oneOf(data.wh_type ?? 'standard', 'wh_type', TYPES),
            address:         optionalString(data.address, 'address'),
            city:            optionalString(data.city, 'city'),
            state:           optionalString(data.state, 'state'),
            country:         optionalString(data.country, 'country'),
            zip:             optionalString(data.zip, 'zip'),
            priority:        requireNumber(data.priority ?? 100, 'priority', { integer: true }),
            default_carrier: optionalString(data.default_carrier, 'default_carrier'),
            status:          oneOf(data.status ?? 'active', 'status', STATUSES),
        };
        if (withCode) {
            w.code = requireString(data.code, 'code', {
                pattern: /^[A-Za-z0-9_-]+$/,
                patternHint: 'may only contain letters, digits, hyphens and underscores',
            }).toUpperCase();
        }
        return w;
    }

    function create(data, userId) {
        const w = validate(data, { withCode: true });
        return db.query(
            `INSERT INTO warehouses (code, name, wh_type, address, city, state, country, zip,
                                     priority, default_carrier, status,
                                     _create_ts, _create_user_id, _modify_ts, _modify_user_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW(), $12, NOW(), $12)
             RETURNING warehouse_no, code, name, wh_type, address, city, state, country, zip,
                       priority, default_carrier, status, _modify_ts`,
            [w.code, w.name, w.wh_type, w.address, w.city, w.state, w.country, w.zip,
             w.priority, w.default_carrier, w.status, userId]
        ).then(res => res.rows[0]);
    }

    /** `code` is immutable — it is not accepted here. */
    function update(warehouseNo, data, userId) {
        const w = validate(data, { withCode: false });
        return db.query(
            `UPDATE warehouses
             SET name=$2, wh_type=$3, address=$4, city=$5, state=$6, country=$7, zip=$8,
                 priority=$9, default_carrier=$10, status=$11, _modify_ts=NOW(), _modify_user_id=$12
             WHERE warehouse_no=$1
             RETURNING warehouse_no, code, name, wh_type, address, city, state, country, zip,
                       priority, default_carrier, status, _modify_ts`,
            [warehouseNo, w.name, w.wh_type, w.address, w.city, w.state, w.country, w.zip,
             w.priority, w.default_carrier, w.status, userId]
        ).then(res => res.rows[0] || null);
    }

}());

module.exports = Warehouses;
