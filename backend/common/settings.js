'use strict';

const { DB: db } = require('./db');

/**
 * Settings — the one way to read admin-editable store settings.
 *
 * app_settings.value is JSONB, so pg already returns it as a native JS
 * value ('"USD"' → 'USD', '15' → 15, 'true' → true). The typed getters
 * exist so a mistyped or hand-edited row degrades to the caller's fallback
 * instead of leaking NaN/undefined into pricing or scheduling math.
 */
const Settings = (function () {

    return { get, getNumber, getString, getBool };

    /** Raw value for a key, or `fallback` when the key is absent. */
    async function get(key, fallback = null) {
        const res = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
        return res.rows.length ? res.rows[0].value : fallback;
    }

    async function getNumber(key, fallback) {
        const value = await get(key);
        const n = Number(value);
        return value !== null && Number.isFinite(n) ? n : fallback;
    }

    async function getString(key, fallback) {
        const value = await get(key);
        return typeof value === 'string' && value !== '' ? value : fallback;
    }

    async function getBool(key, fallback) {
        const value = await get(key);
        return typeof value === 'boolean' ? value : fallback;
    }

}());

module.exports = Settings;
