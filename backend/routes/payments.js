'use strict';

const express           = require('express');
const router            = express.Router();
const requirePermission = require('../middleware/requirePermission');
const PaymentsCntlr     = require('../controllers/PaymentsCntlr')();

// Manual refunds — Finance role (refunds:create)
router.post('/:ord_no/refund', requirePermission('refunds:create'), PaymentsCntlr.refund);

module.exports = router;
