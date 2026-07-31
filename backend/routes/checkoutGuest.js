'use strict';

const { createApiRouter } = require('../common/apiRouter');
const router        = createApiRouter('/api/v1/checkout/guest');
const CheckoutCntlr = require('../controllers/CheckoutCntlr')();

// Public: guest checkout with inline items. Creates an implicit customer
// account keyed by email (OTP login lets the guest view their orders later).
router.post('/', CheckoutCntlr.placeGuest);

// Terminate the chain here: this public mount shares the /api/v1/checkout
// prefix with the authenticated router, so falling through via next() would
// land in the auth middleware and 401 a successful response.
router.use(require('../common/responseHandlers').handleResponse);

module.exports = router;
