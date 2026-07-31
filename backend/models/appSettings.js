'use strict';

const { DB: db, withAudit } = require('../common/db');
const { badRequest, oneOf, requireNumber, requireString } = require('../common/validation');

/**
 * Admin CRUD for app_settings (read side lives in common/settings.js).
 *
 * Keys are code-defined (seeded by migrations, consumed by services) — the
 * admin surface edits values only; there is deliberately no create or delete.
 * Every update must keep the value's JSONB type, and keys with a KEY_RULES
 * entry get domain validation on top so a typo cannot break checkout math or
 * select a provider that doesn't exist.
 */
const AppSettings = (function () {

    // Domain guards per key. Anything not listed is protected by the type
    // check alone. Keep provider enums in sync with the adapter registries.
    //
    // A Map, not an object literal: `key` arrives from the request, and a plain
    // object would resolve 'constructor', '__proto__' and 'toString' to
    // inherited callables. A Map has no prototype chain to walk, so an unknown
    // key is simply absent — the lookup below is safe on its own terms rather
    // than by leaning on the row-existence check in update().
    const KEY_RULES = new Map([
        ['store.name',                 v => requireString(v, 'store.name')],
        ['store.currency',             v => requireString(v, 'store.currency',
                                           { pattern: /^[A-Z]{3}$/, patternHint: 'must be a 3-letter ISO 4217 code (e.g. USD)' })],
        ['reservations.ttl_minutes',   v => requireNumber(v, 'reservations.ttl_minutes', { min: 1, integer: true })],
        ['inventory.partition_months', v => requireNumber(v, 'inventory.partition_months', { min: -1, integer: true })],
        ['returns.window_days',        v => requireNumber(v, 'returns.window_days', { integer: true })],
        ['shipping.free_threshold',    v => requireNumber(v, 'shipping.free_threshold', { min: 0 })],
        ['mail.provider',              v => oneOf(v, 'mail.provider',   ['smtp', 'ses', 'noop'])],
        ['search.provider',            v => oneOf(v, 'search.provider', ['postgres', 'opensearch'])],
        ['tax.provider',               v => oneOf(v, 'tax.provider',    ['local', 'stripe'])],
    ]);

    return { findAll, update };

    function findAll() {
        return db.query(
            `SELECT key, value, descr, _modify_ts FROM app_settings ORDER BY key`
        ).then(res => res.rows);
    }

    /** @returns {Promise<object|null>} updated row, or null when the key does not exist */
    async function update(key, value, userId) {
        const current = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
        if (!current.rows.length) return null;

        if (value === null || value === undefined) {
            throw badRequest(`${key} requires a value`);
        }
        const currentType = typeof current.rows[0].value;
        if (typeof value !== currentType) {
            throw badRequest(`${key} must be a ${currentType}`);
        }
        const rule = KEY_RULES.get(key);
        const normalized = rule ? rule(value) : value;

        return withAudit(userId, (client) => client.query(
            `UPDATE app_settings
             SET value = $2::jsonb, _modify_ts = NOW(), _modify_user_id = $3
             WHERE key = $1
             RETURNING key, value, descr, _modify_ts`,
            [key, JSON.stringify(normalized), userId]
        )).then(res => res.rows[0]);
    }

}());

module.exports = AppSettings;
