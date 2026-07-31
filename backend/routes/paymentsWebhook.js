'use strict';

const express       = require('express');
const { createApiRouter } = require('../common/apiRouter');
const router        = createApiRouter('/api/v1/payments/webhook');
const PaymentsCntlr = require('../controllers/PaymentsCntlr')();

// Raw body is REQUIRED here: providers sign the exact bytes they send, and a
// parsed/re-serialized body breaks signature verification. This router is
// mounted in app.js BEFORE express.json().
router.post('/:provider', express.raw({ type: '*/*', limit: '1mb' }), PaymentsCntlr.webhook);

module.exports = router;
