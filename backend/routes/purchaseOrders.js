'use strict';

const express             = require('express');
const router              = express.Router();
const requirePermission   = require('../middleware/requirePermission');
const PurchaseOrdersCntlr = require('../controllers/PurchaseOrdersCntlr')();

// Reads: purchasing owns POs; inventory staff can look them up (mirrors the
// vendors router). Document lifecycle needs purchasing:manage; the physical
// receipt is warehouse work and needs inventory:receive — the purchasing
// role holds both, inventory_control holds the receive side.
router.get('/',                requirePermission('purchasing:manage', 'inventory:read'), PurchaseOrdersCntlr.list);
router.get('/:po_no',          requirePermission('purchasing:manage', 'inventory:read'), PurchaseOrdersCntlr.findOne);

router.post('/',               requirePermission('purchasing:manage'),  PurchaseOrdersCntlr.create);
router.post('/:po_no/close',   requirePermission('purchasing:manage'),  PurchaseOrdersCntlr.close);
router.post('/:po_no/cancel',  requirePermission('purchasing:manage'),  PurchaseOrdersCntlr.cancel);

router.post('/:po_no/receive', requirePermission('inventory:receive'),  PurchaseOrdersCntlr.receive);

module.exports = router;
