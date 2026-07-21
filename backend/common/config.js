'use strict';

require('dotenv').config();

// ---------------------------------------------------------------------------
// Startup validation — fail fast on a misconfigured deploy, with every
// problem reported at once, rather than at the first email or payment.
// ---------------------------------------------------------------------------

// Valid names for the deployment-level provider selectors. Keep in sync with
// the adapter registries (services/mail/index.js, services/payments/index.js).
const MAIL_PROVIDERS    = ['smtp', 'ses', 'noop'];
const PAYMENT_PROVIDERS = ['fake', 'stripe'];

const BASE_REQUIRED_VARS = [
    'DB_HOST',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
];

const SMTP_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'];

function requiredVars(env) {
    const required = [...BASE_REQUIRED_VARS];

    // SMTP credentials are only needed when SMTP can actually be used. With
    // MAIL_PROVIDER unset, the runtime selection (env → app_settings → 'smtp')
    // can still resolve to SMTP, so the credentials stay required.
    const mail = env.MAIL_PROVIDER;
    if (!mail || mail === 'smtp') required.push(...SMTP_VARS);
    // SES sends from SES_FROM, falling back to SMTP_FROM — one must be set.
    if (mail === 'ses' && !env.SES_FROM) required.push('SMTP_FROM');

    if (env.PAYMENT_PROVIDER === 'stripe') {
        required.push('STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET');
    }

    return required;
}

/**
 * Express `trust proxy` setting, resolved from TRUST_PROXY.
 *
 * Every deployment tier in README.md sits behind a reverse proxy (nginx/ALB),
 * so req.ip / req.protocol must be derived from X-Forwarded-* to attribute the
 * real client rather than the proxy. Accepted forms:
 *   unset / ''        -> false  (trust nobody; correct for a direct-to-internet
 *                                 single instance, and the safe default)
 *   'true' / 'false'  -> boolean
 *   a non-negative int-> hop count: trust exactly N proxies in front (preferred
 *                                    for a known topology — prevents a client
 *                                    from spoofing X-Forwarded-For past them)
 *   anything else     -> passed through to Express as a trusted IP/CIDR list or
 *                        a named preset ('loopback', 'uniquelocal', ...).
 *
 * @param {string|undefined} raw
 * @returns {boolean|number|string}
 */
function parseTrustProxy(raw) {
    if (raw === undefined) return false;
    const value = raw.trim();
    if (value === '' || value === 'false') return false;
    if (value === 'true') return true;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    return value;
}

function validate(env) {
    const problems = [];

    const missing = requiredVars(env).filter(name => !env[name]);
    if (missing.length) {
        problems.push(`missing required environment variables: ${missing.join(', ')}`);
    }

    if (env.MAIL_PROVIDER && !MAIL_PROVIDERS.includes(env.MAIL_PROVIDER)) {
        problems.push(`MAIL_PROVIDER must be one of [${MAIL_PROVIDERS.join(', ')}], got '${env.MAIL_PROVIDER}'`);
    }
    if (env.PAYMENT_PROVIDER && !PAYMENT_PROVIDERS.includes(env.PAYMENT_PROVIDER)) {
        problems.push(`PAYMENT_PROVIDER must be one of [${PAYMENT_PROVIDERS.join(', ')}], got '${env.PAYMENT_PROVIDER}'`);
    }

    // A negative hop count is a typo, not a valid Express spec — catch it here
    // rather than letting Express misread '-1' as a trusted-IP list per request.
    if (env.TRUST_PROXY !== undefined && /^-\d+$/.test(env.TRUST_PROXY.trim())) {
        problems.push(`TRUST_PROXY hop count must be non-negative, got '${env.TRUST_PROXY}'`);
    }

    // The refresh-token cookie must never travel over plain HTTP in
    // production — a deploy that forgets COOKIE_SECURE fails here, not in
    // an incident report.
    if (env.NODE_ENV === 'production' && env.COOKIE_SECURE !== 'true') {
        problems.push("COOKIE_SECURE must be 'true' when NODE_ENV is 'production'");
    }

    if (problems.length) {
        throw new Error(`Invalid configuration: ${problems.join('; ')}`);
    }
}

validate(process.env);

module.exports = {
    db: {
        host:     process.env.DB_HOST,
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        name:     process.env.DB_NAME,
    },
    jwt: {
        accessSecret:      process.env.JWT_ACCESS_SECRET,
        refreshSecret:     process.env.JWT_REFRESH_SECRET,
        accessExpires:     process.env.JWT_ACCESS_EXPIRES || '15m',
        refreshExpiresDays: parseInt(process.env.JWT_REFRESH_EXPIRES, 10) || 7,
    },
    smtp: {
        host:     process.env.SMTP_HOST,
        port:     parseInt(process.env.SMTP_PORT, 10),
        user:     process.env.SMTP_USER,
        password: process.env.SMTP_PASSWORD,
        from:     process.env.SMTP_FROM,
    },
    cookie: {
        secure: process.env.COOKIE_SECURE === 'true',
    },
    port: parseInt(process.env.PORT, 10) || 3000,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    isDev: process.env.NODE_ENV !== 'production',
};
