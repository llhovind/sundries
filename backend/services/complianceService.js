'use strict';

const { DB: db } = require('../common/db');
const { log } = require('../common/logger');

/**
 * ComplianceService — GDPR/CCPA request intake + async processing.
 *
 * STUB STATUS (deliberate, flagged):
 *   gdpr_export — functional first cut: assembles the subject's account,
 *     profile and order history into a JSON document stored on the request
 *     row. Delivery (secure download link / email) is NOT implemented; an
 *     operator retrieves the payload and sends it through an approved channel.
 *   gdpr_delete — intake + staging ONLY. Actual erasure is left manual on
 *     purpose: order/ledger rows are legally retained (tax/audit), so the
 *     correct action is anonymization of PII with retention of transactional
 *     records — a policy decision that needs sign-off before automation.
 *     The processor documents exactly what would be anonymized and parks the
 *     request in 'processing' for a human to complete.
 */
const ComplianceService = (function () {

    return { createRequest, process: processRequest, list };

    async function createRequest({ req_type, email, customer_id = null }) {
        if (!['gdpr_export', 'gdpr_delete'].includes(req_type)) {
            throw Object.assign(new Error('req_type must be gdpr_export or gdpr_delete'), { status: 400 });
        }
        if (!email) throw Object.assign(new Error('email is required'), { status: 400 });
        const res = await db.query(
            `INSERT INTO compliance_requests (req_type, email, _customer_id)
             VALUES ($1, $2, $3) RETURNING id, req_type, status`,
            [req_type, email, customer_id]
        );
        return res.rows[0];
    }

    /** Async processor — invoked from the job queue. */
    async function processRequest(requestId) {
        const res = await db.query(
            `SELECT id, req_type, email, status FROM compliance_requests WHERE id = $1`, [requestId]);
        const request = res.rows[0];
        if (!request || request.status !== 'pending') return { skipped: true };

        if (request.req_type === 'gdpr_export') {
            const payload = await buildExport(request.email);
            await db.query(
                `UPDATE compliance_requests
                 SET status = 'completed', completed_at = NOW(),
                     notes = $2
                 WHERE id = $1`,
                [requestId, JSON.stringify(payload)]
            );
            log('info', 'gdpr export assembled (delivery is manual — see service doc)', { requestId });
            return { completed: true };
        }

        // gdpr_delete: stage, document, park for manual completion.
        const summary = await deletionSummary(request.email);
        await db.query(
            `UPDATE compliance_requests
             SET status = 'processing',
                 notes = $2
             WHERE id = $1`,
            [requestId, `STUB: automated erasure not enabled. Manual anonymization required for: ${JSON.stringify(summary)}. ` +
                        `Order and ledger rows are retained (tax/audit); anonymize PII columns only.`]
        );
        log('warn', 'gdpr delete staged — manual anonymization required (automation is a stub)', { requestId });
        return { staged: true };
    }

    async function buildExport(email) {
        const [user, customer, orders] = await Promise.all([
            db.query(`SELECT id, username, email, status, is_guest, _create_ts
                      FROM users WHERE lower(email) = lower($1)`, [email]).then(r => r.rows[0] || null),
            db.query(`SELECT id, name, email, address, city, state, country, zip, phone, _create_ts
                      FROM customers WHERE lower(email) = lower($1)`, [email]).then(r => r.rows),
            db.query(`SELECT o.ord_no, o.status, o.currency, o.total, o.placed_at,
                             o.ship_name, o.ship_address, o.ship_city, o.ship_state, o.ship_zip
                      FROM orders o WHERE lower(o.email) = lower($1)
                      ORDER BY o.placed_at`, [email]).then(r => r.rows),
        ]);
        return { generated_at: new Date().toISOString(), subject_email: email, user, customers: customer, orders };
    }

    async function deletionSummary(email) {
        const [users, customers, orders] = await Promise.all([
            db.query(`SELECT COUNT(*)::int AS n FROM users WHERE lower(email) = lower($1)`, [email]),
            db.query(`SELECT COUNT(*)::int AS n FROM customers WHERE lower(email) = lower($1)`, [email]),
            db.query(`SELECT COUNT(*)::int AS n FROM orders WHERE lower(email) = lower($1)`, [email]),
        ]);
        return {
            users_to_anonymize: users.rows[0].n,
            customer_profiles_to_anonymize: customers.rows[0].n,
            orders_to_retain_with_pii_scrub: orders.rows[0].n,
        };
    }

    function list({ status = null, limit = 50, offset = 0 } = {}) {
        const params = [];
        let where = '';
        if (status) { params.push(status); where = `WHERE status = $1`; }
        params.push(offset, limit);
        return db.query(
            `SELECT id, req_type, email, status, requested_at, completed_at,
                    COUNT(*) OVER()::int AS _total
             FROM compliance_requests ${where}
             ORDER BY requested_at DESC
             OFFSET $${params.length - 1} LIMIT $${params.length}`,
            params
        ).then(res => ({
            rows: res.rows.map(({ _total, ...r }) => r),
            total: res.rows.length ? res.rows[0]._total : 0,
        }));
    }

}());

module.exports = ComplianceService;
