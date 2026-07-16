'use strict';

const express             = require('express');
const router              = express.Router();
const { guard }           = require('../config/routePermissions');
const StockTransfersCntlr = require('../controllers/StockTransfersCntlr')();

// Mounted under /api/v1/inventory/transfers (see routes/inventory.js).
// Reads: anyone who can see inventory. Lifecycle: inventory:transfer
// (inventory_control and admin roles).
router.get('/',                        guard('GET /api/v1/inventory/transfers'),                        StockTransfersCntlr.list);
router.get('/:transfer_no',            guard('GET /api/v1/inventory/transfers/:transfer_no'),           StockTransfersCntlr.findOne);

router.post('/',                       guard('POST /api/v1/inventory/transfers'),                       StockTransfersCntlr.create);
router.post('/:transfer_no/dispatch',  guard('POST /api/v1/inventory/transfers/:transfer_no/dispatch'), StockTransfersCntlr.dispatch);
router.post('/:transfer_no/receive',   guard('POST /api/v1/inventory/transfers/:transfer_no/receive'),  StockTransfersCntlr.receive);
router.post('/:transfer_no/cancel',    guard('POST /api/v1/inventory/transfers/:transfer_no/cancel'),   StockTransfersCntlr.cancel);

module.exports = router;
