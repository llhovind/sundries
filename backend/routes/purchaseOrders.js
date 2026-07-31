'use strict';

const { createApiRouter } = require('../common/apiRouter');
const router              = createApiRouter('/api/v1/purchase-orders');
const { guard }           = require('../config/routePermissions');
const PurchaseOrdersCntlr = require('../controllers/PurchaseOrdersCntlr')();

// Reads: purchasing owns POs; inventory staff can look them up (mirrors the
// vendors router). Document lifecycle needs purchasing:manage; the physical
// receipt is warehouse work and needs inventory:receive — the purchasing
// role holds both, inventory_control holds the receive side.
router.get('/',                guard('GET /api/v1/purchase-orders'),               PurchaseOrdersCntlr.list);
router.get('/:po_no',          guard('GET /api/v1/purchase-orders/:po_no'),        PurchaseOrdersCntlr.findOne);

router.post('/',               guard('POST /api/v1/purchase-orders'),              PurchaseOrdersCntlr.create);
router.post('/:po_no/close',   guard('POST /api/v1/purchase-orders/:po_no/close'), PurchaseOrdersCntlr.close);
router.post('/:po_no/cancel',  guard('POST /api/v1/purchase-orders/:po_no/cancel'), PurchaseOrdersCntlr.cancel);

router.post('/:po_no/receive', guard('POST /api/v1/purchase-orders/:po_no/receive'), PurchaseOrdersCntlr.receive);

module.exports = router;
