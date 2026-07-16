'use strict';

const express           = require('express');
const router            = express.Router();
const { guard }         = require('../config/routePermissions');
const RmasCntlr         = require('../controllers/RmasCntlr')();

// Customers open returns on their own orders and see their own RMAs;
// staff scope is decided in the controller via rma:manage.
router.post('/',                 RmasCntlr.request);
router.get('/',                  RmasCntlr.list);
router.get('/:rma_no',           RmasCntlr.findOne);

// Staff lifecycle
router.put('/:rma_no/status',    guard('PUT /api/v1/rmas/:rma_no/status'),    RmasCntlr.updateStatus);
router.post('/:rma_no/receive',  guard('POST /api/v1/rmas/:rma_no/receive'),  RmasCntlr.receive);

// Finance credits the sale
router.post('/:rma_no/refund',   guard('POST /api/v1/rmas/:rma_no/refund'),   RmasCntlr.refund);

module.exports = router;
