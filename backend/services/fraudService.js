'use strict';

const { DB: db } = require('../common/db');

/**
 * FraudService — lowest-cost screening, per the agreed approach:
 *
 *   Layer 1 (free, provider-side): Stripe Radar's ML scoring + AVS/CVC checks
 *   run automatically on every real Stripe payment — nothing to do here.
 *   PayPal screens on its own side likewise.
 *
 *   Layer 2 (this module): cheap in-app velocity rules that FLAG orders for
 *   Customer Service review — they never block a sale. A flagged order gets
 *   orders.fraud_flag = true with the triggered reasons in fraud_notes.
 *
 * Rules:
 *   - velocity: more than MAX_ORDERS_PER_HOUR orders from one email in 1h
 *   - disposable email domains (small built-in list; extend as needed)
 *   - shipping country differs from the store's home country (soft signal)
 */
const FraudService = (function () {

    const MAX_ORDERS_PER_HOUR = 5;
    const HOME_COUNTRY = 'US';
    const DISPOSABLE_DOMAINS = new Set([
        'mailinator.com', 'guerrillamail.com', '10minutemail.com',
        'tempmail.com', 'throwaway.email', 'yopmail.com', 'sharklasers.com',
    ]);

    return { screen, screenAndFlag };

    /**
     * Pure evaluation — returns the triggered reasons without side effects.
     *
     * @param {{ord_no:number, email:string, ship_country?:string}} order
     * @returns {Promise<{flagged:boolean, reasons:string[]}>}
     */
    async function screen(order) {
        const reasons = [];

        const domain = (order.email || '').split('@')[1]?.toLowerCase();
        if (domain && DISPOSABLE_DOMAINS.has(domain)) {
            reasons.push(`disposable email domain: ${domain}`);
        }

        const velo = await db.query(
            `SELECT COUNT(*)::int AS n FROM orders
             WHERE lower(email) = lower($1) AND placed_at > NOW() - INTERVAL '1 hour'`,
            [order.email]
        );
        if (velo.rows[0].n > MAX_ORDERS_PER_HOUR) {
            reasons.push(`velocity: ${velo.rows[0].n} orders from this email in the last hour`);
        }

        if (order.ship_country && order.ship_country.toUpperCase() !== HOME_COUNTRY) {
            reasons.push(`international shipping destination: ${order.ship_country}`);
        }

        return { flagged: reasons.length > 0, reasons };
    }

    /**
     * Screens the order and persists the flag. Runs post-placement (from the
     * job queue) so screening latency and failures never touch checkout —
     * an error here is logged, not surfaced to the customer.
     */
    async function screenAndFlag(ordNo) {
        const res = await db.query(
            `SELECT ord_no, email, ship_country FROM orders WHERE ord_no = $1`, [ordNo]);
        if (!res.rows.length) return { flagged: false, reasons: [] };

        const verdict = await screen(res.rows[0]);
        if (verdict.flagged) {
            await db.query(
                `UPDATE orders SET fraud_flag = TRUE, fraud_notes = $2, _modify_ts = NOW()
                 WHERE ord_no = $1`,
                [ordNo, verdict.reasons.join('; ')]
            );
        }
        return verdict;
    }

}());

module.exports = FraudService;
