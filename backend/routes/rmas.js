'use strict';

const express           = require('express');
const router            = express.Router();
const requirePermission = require('../middleware/requirePermission');
const RmasCntlr         = require('../controllers/RmasCntlr')();

// Customers open returns on their own orders and see their own RMAs;
// staff scope is decided in the controller via rma:manage.
router.post('/',                 RmasCntlr.request);
router.get('/',                  RmasCntlr.list);
router.get('/:rma_no',           RmasCntlr.findOne);

// Staff lifecycle
router.put('/:rma_no/status',    requirePermission('rma:manage'),     RmasCntlr.updateStatus);
router.post('/:rma_no/receive',  requirePermission('rma:manage'),     RmasCntlr.receive);

// Finance credits the sale
router.post('/:rma_no/refund',   requirePermission('refunds:create'), RmasCntlr.refund);

module.exports = router;
