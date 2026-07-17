'use strict';

const { DB: db } = require('../common/db');
const { badRequest } = require('../common/validation');

/**
 * Read-side repository for audit_log. Rows are written exclusively by the
 * fn_audit_row DB triggers (see migrations 001/012) inside withAudit()
 * transactions — there is deliberately no create/update/delete here, and the
 * table itself blocks mutation via trigger.
 */
const AuditLog = (function () {

    const ACTIONS = ['INSERT', 'UPDATE', 'DELETE'];

    return { findAll, entities };

    /**
     * Filtered, paginated audit trail, newest first. All filters are ANDed;
     * `search` matches entity_id, correlation_id, and the actor's username or
     * email (finding "everything this person touched" is the primary use).
     *
     * @param {object} opts
     * @param {string} [opts.search]
     * @param {string} [opts.entity]  - exact table name, e.g. 'app_settings'
     * @param {string} [opts.action]  - INSERT | UPDATE | DELETE
     * @param {number} [opts.actorUserId]
     * @param {string} [opts.from]    - ISO date/timestamp lower bound (inclusive)
     * @param {string} [opts.to]      - ISO date/timestamp upper bound (exclusive)
     * @param {number} opts.limit
     * @param {number} opts.offset
     * @returns {Promise<{rows: Array<object>, total: number}>}
     */
    async function findAll({ search, entity, action, actorUserId, from, to, limit, offset }) {
        const where = [];
        const vals  = [];

        if (entity) { vals.push(entity); where.push(`a.entity = $${vals.length}`); }
        if (action) {
            const upper = String(action).toUpperCase();
            if (!ACTIONS.includes(upper)) {
                throw badRequest(`action must be one of ${ACTIONS.join(', ')}`);
            }
            vals.push(upper);
            where.push(`a.action = $${vals.length}`);
        }
        if (actorUserId !== undefined) {
            const id = parseInt(actorUserId, 10);
            if (isNaN(id)) throw badRequest('actor must be a user id');
            vals.push(id);
            where.push(`a.actor_user_id = $${vals.length}`);
        }
        if (from) { vals.push(parseTs(from, 'from')); where.push(`a.ts >= $${vals.length}`); }
        if (to)   { vals.push(parseTs(to, 'to'));     where.push(`a.ts < $${vals.length}`); }
        if (search) {
            vals.push(`%${search}%`);
            where.push(`(a.entity_id ILIKE $${vals.length} OR a.correlation_id ILIKE $${vals.length}
                         OR u.username ILIKE $${vals.length} OR u.email ILIKE $${vals.length})`);
        }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        vals.push(limit, offset);

        const res = await db.query(
            `SELECT a.audit_no, a.ts, a.actor_user_id, u.username AS actor_username,
                    u.email AS actor_email, a.action, a.entity, a.entity_id,
                    a.old_data, a.new_data, a.ip, a.correlation_id,
                    COUNT(*) OVER() AS total
             FROM audit_log a
             LEFT JOIN users u ON u.id = a.actor_user_id
             ${whereSql}
             ORDER BY a.ts DESC, a.audit_no DESC
             LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
            vals
        );
        const total = res.rows.length ? Number(res.rows[0].total) : await countOnly(whereSql, vals.slice(0, -2));
        return { rows: res.rows.map(({ total: _t, ...row }) => row), total };
    }

    /** COUNT fallback for pages past the end (window count needs >= 1 row). */
    function countOnly(whereSql, vals) {
        return db.query(
            `SELECT COUNT(*) AS total
             FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id ${whereSql}`,
            vals
        ).then(res => Number(res.rows[0].total));
    }

    function parseTs(value, label) {
        const d = new Date(value);
        if (isNaN(d.getTime())) throw badRequest(`${label} must be an ISO date or timestamp`);
        return d.toISOString();
    }

    /** Distinct audited entities — feeds the UI filter dropdown. */
    function entities() {
        return db.query(`SELECT DISTINCT entity FROM audit_log ORDER BY entity`)
            .then(res => res.rows.map(r => r.entity));
    }

}());

module.exports = AuditLog;
