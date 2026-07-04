'use strict';

/**
 * SearchProvider registry. Selection: SEARCH_PROVIDER env (deployment-level,
 * wins) → app_settings 'search.provider' → 'postgres'.
 */

const { DB: db } = require('../../common/db');

const ADAPTERS = {
    get postgres()   { return require('./postgresAdapter'); },
    get opensearch() { return require('./openSearchAdapter'); },
};

const SETTING_CACHE_MS = 60000;
let cached = { value: null, at: 0 };

async function settingProvider() {
    if (Date.now() - cached.at < SETTING_CACHE_MS) return cached.value;
    try {
        const res = await db.query(`SELECT value FROM app_settings WHERE key = 'search.provider'`);
        cached = { value: res.rows.length ? String(res.rows[0].value).replace(/"/g, '') : null, at: Date.now() };
    } catch (err) {
        cached = { value: null, at: Date.now() };
    }
    return cached.value;
}

async function getSearchProvider() {
    const name = process.env.SEARCH_PROVIDER || await settingProvider() || 'postgres';
    const adapter = ADAPTERS[name];
    if (!adapter) throw new Error(`Unknown search provider: ${name}`);
    return adapter;
}

module.exports = { getSearchProvider };
