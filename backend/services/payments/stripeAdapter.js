'use strict';

/**
 * StripeAdapter — real Stripe implementation of the PaymentProvider port.
 *
 * Requires: `npm install stripe` and env STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET.
 * The SDK is required lazily so installs that only use the fake provider
 * don't need the dependency.
 *
 * Flow: manual-capture PaymentIntents (authorize at checkout, capture at
 * fulfillment — matches the backorder capture-on-fulfillment policy).
 * Card data never touches this server: the frontend confirms the intent with
 * Stripe Elements using the clientSecret; state lands here via webhooks only.
 */
const StripeAdapter = (function () {

    const PROVIDER = 'stripe';
    let stripe = null;

    function client() {
        if (!stripe) {
            if (!process.env.STRIPE_SECRET_KEY) {
                throw new Error('STRIPE_SECRET_KEY is required for the stripe payment provider');
            }
            // eslint-disable-next-line global-require
            const Stripe = require('stripe');
            stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
                timeout: 10000,          // never hang a checkout on a slow provider
                maxNetworkRetries: 2,    // idempotency keys make retries safe
            });
        }
        return stripe;
    }

    // Stripe event type → normalized type
    const EVENT_MAP = {
        'payment_intent.amount_capturable_updated': 'authorized',
        'payment_intent.succeeded':                 'captured',
        'payment_intent.payment_failed':            'failed',
        'payment_intent.canceled':                  'cancelled',
        'charge.refunded':                          'refunded',
    };

    return { provider: PROVIDER, createIntent, capture, cancel, refund, verifyWebhook };

    async function createIntent({ amount, currency, idempotencyKey, metadata = {} }) {
        const intent = await client().paymentIntents.create({
            amount: Math.round(amount * 100),          // Stripe uses minor units
            currency: currency.toLowerCase(),
            capture_method: 'manual',                  // authorize now, capture on fulfillment
            automatic_payment_methods: { enabled: true },
            metadata,
        }, { idempotencyKey });
        return { intentRef: intent.id, clientSecret: intent.client_secret, status: intent.status };
    }

    async function capture(intentRef) {
        const intent = await client().paymentIntents.capture(intentRef);
        return { intentRef: intent.id, status: intent.status };
    }

    async function cancel(intentRef) {
        const intent = await client().paymentIntents.cancel(intentRef);
        return { intentRef: intent.id, status: intent.status };
    }

    async function refund(intentRef, amount) {
        const r = await client().refunds.create({
            payment_intent: intentRef,
            amount: amount != null ? Math.round(amount * 100) : undefined,
        });
        return { refundRef: r.id, intentRef, amount, status: r.status };
    }

    /**
     * Verifies the Stripe-Signature header against the raw body. The webhook
     * route must use express.raw() — a parsed body breaks signature checks.
     */
    async function verifyWebhook(headers, rawBody) {
        if (!process.env.STRIPE_WEBHOOK_SECRET) {
            throw new Error('STRIPE_WEBHOOK_SECRET is required to verify Stripe webhooks');
        }
        const event = client().webhooks.constructEvent(
            rawBody, headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET
        );
        const type = EVENT_MAP[event.type];
        if (!type) return null;   // event type we don't consume — caller acks and ignores
        const object = event.data.object;
        const intentRef = object.object === 'charge' ? object.payment_intent : object.id;
        return { eventId: event.id, type, intentRef, raw: event };
    }

}());

module.exports = StripeAdapter;
