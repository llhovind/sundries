'use strict';

/**
 * MailProvider registry. Selection: MAIL_PROVIDER env (deployment-level,
 * wins) → app_settings 'mail.provider' (admin-editable default) → 'smtp'.
 * The app_settings value is cached briefly so mail sends don't add a DB
 * round-trip each time.
 */

const { DB: db } = require('../../common/db');

const ADAPTERS = {
    get smtp() { return require('./smtpAdapter'); },
    get ses()  { return require('./sesAdapter'); },
    get noop() { return require('./noopAdapter'); },   // tests / mail-less installs
};

const SETTING_CACHE_MS = 60000;
let cached = { value: null, at: 0 };

async function settingProvider() {
    if (Date.now() - cached.at < SETTING_CACHE_MS) return cached.value;
    try {
        const res = await db.query(`SELECT value FROM app_settings WHERE key = 'mail.provider'`);
        cached = { value: res.rows.length ? String(res.rows[0].value).replace(/"/g, '') : null, at: Date.now() };
    } catch (err) {
        cached = { value: null, at: Date.now() };
    }
    return cached.value;
}

async function getMailProvider() {
    const name = process.env.MAIL_PROVIDER || await settingProvider() || 'smtp';
    const adapter = ADAPTERS[name];
    if (!adapter) throw new Error(`Unknown mail provider: ${name}`);
    return adapter;
}

module.exports = { getMailProvider };
