'use strict';

const express             = require('express');
const router              = express.Router();
const requirePermission   = require('../middleware/requirePermission');
const StockTransfersCntlr = require('../controllers/StockTransfersCntlr')();

// Mounted under /api/v1/inventory/transfers (see routes/inventory.js).
// Reads: anyone who can see inventory. Lifecycle: inventory:transfer
// (inventory_control and admin roles).
router.get('/',                        requirePermission('inventory:read'),     StockTransfersCntlr.list);
router.get('/:transfer_no',            requirePermission('inventory:read'),     StockTransfersCntlr.findOne);

router.post('/',                       requirePermission('inventory:transfer'), StockTransfersCntlr.create);
router.post('/:transfer_no/dispatch',  requirePermission('inventory:transfer'), StockTransfersCntlr.dispatch);
router.post('/:transfer_no/receive',   requirePermission('inventory:transfer'), StockTransfersCntlr.receive);
router.post('/:transfer_no/cancel',    requirePermission('inventory:transfer'), StockTransfersCntlr.cancel);

module.exports = router;
