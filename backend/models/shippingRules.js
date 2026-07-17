'use strict';

const { DB: db, withAudit } = require('../common/db');
const { badRequest, requireString, requireNumber, optionalNumber, oneOf } = require('../common/validation');

/**
 * Shipping pricing configuration: shipping_rules (base rate by subtotal
 * range, highest-priority match wins) and shipping_weight_bands (per-package
 * freight surcharges). Consumed by services/shippingService.js at checkout.
 *
 * Rows are never deleted — pricing history should stay inspectable — they are
 * disabled via status, which the calculator already filters on.
 */
const ShippingRules = (function () {

    const STATUSES = ['active', 'inactive'];

    return {
        findAllRules, createRule, updateRule,
        findAllBands, createBand, updateBand,
    };

    // ── Subtotal rules ───────────────────────────────────────────────────

    function findAllRules() {
        return db.query(
            `SELECT rule_no, name, min_subtotal, max_subtotal, base_amount, priority, status, _modify_ts
             FROM shipping_rules ORDER BY priority, min_subtotal`
        ).then(res => res.rows);
    }

    function validateRule(data) {
        const rule = {
            name:         requireString(data.name, 'name'),
            min_subtotal: requireNumber(data.min_subtotal ?? 0, 'min_subtotal', { min: 0 }),
            max_subtotal: optionalNumber(data.max_subtotal, 'max_subtotal', { min: 0 }),
            base_amount:  requireNumber(data.base_amount, 'base_amount', { min: 0 }),
            priority:     requireNumber(data.priority ?? 100, 'priority', { integer: true }),
            status:       oneOf(data.status ?? 'active', 'status', STATUSES),
        };
        if (rule.max_subtotal !== null && rule.max_subtotal <= rule.min_subtotal) {
            throw badRequest('max_subtotal must be greater than min_subtotal');
        }
        return rule;
    }

    function createRule(data, userId) {
        const r = validateRule(data);
        return withAudit(userId, (client) => client.query(
            `INSERT INTO shipping_rules (name, min_subtotal, max_subtotal, base_amount, priority, status,
                                         _create_ts, _modify_ts, _modify_user_id)
             VALUES ($1,$2,$3,$4,$5,$6, NOW(), NOW(), $7)
             RETURNING rule_no, name, min_subtotal, max_subtotal, base_amount, priority, status, _modify_ts`,
            [r.name, r.min_subtotal, r.max_subtotal, r.base_amount, r.priority, r.status, userId]
        )).then(res => res.rows[0]);
    }

    function updateRule(ruleNo, data, userId) {
        const r = validateRule(data);
        return withAudit(userId, (client) => client.query(
            `UPDATE shipping_rules
             SET name=$2, min_subtotal=$3, max_subtotal=$4, base_amount=$5, priority=$6, status=$7,
                 _modify_ts=NOW(), _modify_user_id=$8
             WHERE rule_no=$1
             RETURNING rule_no, name, min_subtotal, max_subtotal, base_amount, priority, status, _modify_ts`,
            [ruleNo, r.name, r.min_subtotal, r.max_subtotal, r.base_amount, r.priority, r.status, userId]
        )).then(res => res.rows[0] || null);
    }

    // ── Weight bands ─────────────────────────────────────────────────────

    function findAllBands() {
        return db.query(
            `SELECT band_no, min_weight_lbs, max_weight_lbs, surcharge, status, _modify_ts
             FROM shipping_weight_bands ORDER BY min_weight_lbs`
        ).then(res => res.rows);
    }

    function validateBand(data) {
        const band = {
            min_weight_lbs: requireNumber(data.min_weight_lbs, 'min_weight_lbs', { min: 0 }),
            max_weight_lbs: optionalNumber(data.max_weight_lbs, 'max_weight_lbs', { min: 0 }),
            surcharge:      requireNumber(data.surcharge, 'surcharge', { min: 0 }),
            status:         oneOf(data.status ?? 'active', 'status', STATUSES),
        };
        if (band.max_weight_lbs !== null && band.max_weight_lbs <= band.min_weight_lbs) {
            throw badRequest('max_weight_lbs must be greater than min_weight_lbs');
        }
        return band;
    }

    function createBand(data, userId) {
        const b = validateBand(data);
        return withAudit(userId, (client) => client.query(
            `INSERT INTO shipping_weight_bands (min_weight_lbs, max_weight_lbs, surcharge, status,
                                                _create_ts, _modify_ts, _modify_user_id)
             VALUES ($1,$2,$3,$4, NOW(), NOW(), $5)
             RETURNING band_no, min_weight_lbs, max_weight_lbs, surcharge, status, _modify_ts`,
            [b.min_weight_lbs, b.max_weight_lbs, b.surcharge, b.status, userId]
        )).then(res => res.rows[0]);
    }

    function updateBand(bandNo, data, userId) {
        const b = validateBand(data);
        return withAudit(userId, (client) => client.query(
            `UPDATE shipping_weight_bands
             SET min_weight_lbs=$2, max_weight_lbs=$3, surcharge=$4, status=$5,
                 _modify_ts=NOW(), _modify_user_id=$6
             WHERE band_no=$1
             RETURNING band_no, min_weight_lbs, max_weight_lbs, surcharge, status, _modify_ts`,
            [bandNo, b.min_weight_lbs, b.max_weight_lbs, b.surcharge, b.status, userId]
        )).then(res => res.rows[0] || null);
    }

}());

module.exports = ShippingRules;
