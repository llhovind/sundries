'use strict';

const { createApiRouter } = require('../common/apiRouter');
const router            = createApiRouter('/api/v1/payments');
const { guard }         = require('../config/routePermissions');
const PaymentsCntlr     = require('../controllers/PaymentsCntlr')();

// Manual refunds — Finance role (refunds:create)
router.post('/:ord_no/refund', guard('POST /api/v1/payments/:ord_no/refund'), PaymentsCntlr.refund);

module.exports = router;
