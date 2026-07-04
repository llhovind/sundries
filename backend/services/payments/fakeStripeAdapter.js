'use strict';

const crypto = require('crypto');

/**
 * FakeStripeAdapter — a local, deterministic Stripe stand-in for demos and
 * integration tests. Implements the PaymentProvider port:
 *
 *   createIntent({ amount, currency, idempotencyKey, metadata })
 *   capture(intentRef)
 *   cancel(intentRef)
 *   refund(intentRef, amount)
 *   verifyWebhook(headers, body) → normalized event
 *
 * No card data, no network. The "customer completing payment" step is
 * simulated by POST /api/v1/payments/fake/confirm { intent_ref, outcome },
 * which synthesizes the webhook event a real provider would deliver — so the
 * application exercises the exact same webhook-driven code path as production.
 *
 * Normalized event shape (every adapter returns this from verifyWebhook):
 *   { eventId, type: 'authorized'|'captured'|'failed'|'cancelled'|'refunded',
 *     intentRef, raw }
 */
const FakeStripeAdapter = (function () {

    const PROVIDER = 'fake';

    return { provider: PROVIDER, createIntent, capture, cancel, refund, verifyWebhook, makeEvent };

    function rid(prefix) {
        return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
    }

    /**
     * @returns {Promise<{intentRef:string, clientSecret:string, status:string}>}
     */
    async function createIntent({ amount, currency, idempotencyKey, metadata = {} }) {
        if (!(amount > 0)) throw Object.assign(new Error('amount must be positive'), { status: 400 });
        const intentRef = rid('fpi');
        return {
            intentRef,
            clientSecret: `${intentRef}_secret_${crypto.randomBytes(8).toString('hex')}`,
            status: 'requires_confirmation',
            amount,
            currency,
            idempotencyKey,
            metadata,
        };
    }

    async function capture(intentRef) {
        return { intentRef, status: 'captured', capturedAt: new Date().toISOString() };
    }

    async function cancel(intentRef) {
        return { intentRef, status: 'cancelled' };
    }

    async function refund(intentRef, amount) {
        return { refundRef: rid('fre'), intentRef, amount, status: 'succeeded' };
    }

    /**
     * The fake provider posts plain JSON, no signature. Body arrives raw
     * (Buffer) because the webhook route uses express.raw for parity with
     * providers that do sign.
     */
    async function verifyWebhook(_headers, body) {
        const raw = Buffer.isBuffer(body) ? body.toString('utf8') : (typeof body === 'string' ? body : JSON.stringify(body));
        const evt = JSON.parse(raw);
        if (!evt.eventId || !evt.type || !evt.intentRef) {
            throw Object.assign(new Error('Malformed fake webhook event'), { status: 400 });
        }
        return { eventId: evt.eventId, type: evt.type, intentRef: evt.intentRef, raw: evt };
    }

    /**
     * Builds the event the /fake/confirm demo endpoint feeds into the webhook
     * pipeline — the moral equivalent of Stripe calling us back.
     */
    function makeEvent(type, intentRef) {
        return { eventId: rid('fevt'), type, intentRef };
    }

}());

module.exports = FakeStripeAdapter;
