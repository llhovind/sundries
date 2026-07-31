'use strict';

const { createApiRouter } = require('../common/apiRouter');
const router            = createApiRouter('/api/v1/promotions');
const { guard }         = require('../config/routePermissions');
const PromotionsCntlr   = require('../controllers/PromotionsCntlr')();

// Customer-facing: pre-validate a code against a cart subtotal
router.post('/validate', PromotionsCntlr.validate);

// Admin management (promotions:manage)
router.get('/',           guard('GET /api/v1/promotions'),           PromotionsCntlr.list);
router.post('/',          guard('POST /api/v1/promotions'),          PromotionsCntlr.create);
router.put('/:promo_no',  guard('PUT /api/v1/promotions/:promo_no'), PromotionsCntlr.update);

module.exports = router;
