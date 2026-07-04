'use strict';

/**
 * PaymentProvider registry. Selection order:
 *   1. explicit `provider` argument (per-payment override)
 *   2. PAYMENT_PROVIDER env (validated at startup in common/config.js)
 *
 * The fake provider is for local demos/tests. It refuses to run in
 * production unless explicitly allowed, so a misconfigured deploy cannot
 * silently "accept" payments.
 */

const fake   = require('./fakeStripeAdapter');

const ADAPTERS = {
    fake,
    get stripe() { return require('./stripeAdapter'); },   // lazy: SDK optional
};

function getProvider(name) {
    const selected = name || process.env.PAYMENT_PROVIDER || 'fake';
    const adapter  = ADAPTERS[selected];
    if (!adapter) {
        throw Object.assign(new Error(`Unknown payment provider: ${selected}`), { status: 400 });
    }
    if (selected === 'fake'
        && process.env.NODE_ENV === 'production'
        && process.env.ALLOW_FAKE_PAYMENTS !== 'true') {
        throw new Error('The fake payment provider is disabled in production (set ALLOW_FAKE_PAYMENTS=true to demo)');
    }
    return adapter;
}

module.exports = { getProvider };
