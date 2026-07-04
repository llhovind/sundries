'use strict';

const express       = require('express');
const router        = express.Router();
const PaymentsCntlr = require('../controllers/PaymentsCntlr')();

// LOCAL DEMO ONLY — simulates the shopper completing payment at the provider.
// Refused in production unless ALLOW_FAKE_PAYMENTS=true (see payments registry).
router.post('/confirm', PaymentsCntlr.fakeConfirm);

// Terminate the chain here: this public mount shares the /api/v1/payments
// prefix with the authenticated router, so falling through via next() would
// land in the auth middleware and 401 a successful response.
router.use(require('../common/responseHandlers').handleResponse);

module.exports = router;
