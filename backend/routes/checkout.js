'use strict';

const { createApiRouter } = require('../common/apiRouter');
const router        = createApiRouter('/api/v1/checkout');
const CheckoutCntlr = require('../controllers/CheckoutCntlr')();

// Authenticated checkout (guest checkout is mounted separately, unauthenticated)
router.post('/',                CheckoutCntlr.place);
router.post('/:ord_no/cancel',  CheckoutCntlr.cancel);

module.exports = router;
