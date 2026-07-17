'use strict';

const PaymentsService = require('../services/paymentsService');
const fakeAdapter     = require('../services/payments/fakeStripeAdapter');
const { getProvider } = require('../services/payments');
const { log }         = require('../common/logger');

const PaymentsCntlr = function () {

    const FAKE_OUTCOMES = ['authorized', 'captured', 'failed', 'cancelled'];

    return { webhook, fakeConfirm, refund };

    // POST /api/v1/payments/webhook/:provider — raw body, provider-verified.
    // Always 2xx on handled/duplicate/orphan so providers stop retrying;
    // 400 on verification failure so tampering is visible in provider logs.
    function webhook(req, res) {
        PaymentsService.handleWebhook(req.params.provider, req.headers, req.body)
            .then(result => res.status(200).json(result))
            .catch(err => {
                log('error', 'webhook processing failed', {
                    provider: req.params.provider, error: err.message,
                });
                res.status(err.status || 400).json({ message: 'Webhook rejected' });
            });
    }

    // POST /api/v1/payments/fake/confirm — LOCAL DEMO ONLY.
    // Simulates the shopper completing (or failing) payment at the provider:
    // synthesizes the webhook event a real Stripe would deliver.
    function fakeConfirm(req, res, next) {
        try {
            getProvider('fake');   // throws in production unless explicitly allowed
        } catch (err) {
            return next({ status: 403, message: err.message });
        }
        const { intent_ref, outcome = 'authorized' } = req.body || {};
        if (!intent_ref) return next({ status: 400, message: 'intent_ref is required' });
        if (!FAKE_OUTCOMES.includes(outcome)) {
            return next({ status: 400, message: `outcome must be one of: ${FAKE_OUTCOMES.join(', ')}` });
        }

        PaymentsService.processEvent('fake', fakeAdapter.makeEvent(outcome, intent_ref))
            .then(result => {
                res.locals.results = result;
                res.locals.status  = 200;
                res.locals.message = `Fake payment ${outcome}`;
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

    // POST /api/v1/payments/:ord_no/refund — Finance (refunds:create)
    function refund(req, res, next) {
        const ordNo = parseInt(req.params.ord_no, 10);
        if (isNaN(ordNo)) return next({ status: 400, message: 'Invalid order number' });
        const { amount, reason } = req.body || {};

        PaymentsService.refundOrder(ordNo, Number(amount), reason, req.user.id)
            .then(result => {
                res.locals.results = result;
                res.locals.status  = 201;
                res.locals.message = 'Refund issued';
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message || 'Refund failed' }));
    }

};

module.exports = PaymentsCntlr;
