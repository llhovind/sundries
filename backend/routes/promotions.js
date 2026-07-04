'use strict';

const express           = require('express');
const router            = express.Router();
const requirePermission = require('../middleware/requirePermission');
const PromotionsCntlr   = require('../controllers/PromotionsCntlr')();

// Customer-facing: pre-validate a code against a cart subtotal
router.post('/validate', PromotionsCntlr.validate);

// Admin management (promotions:manage)
router.get('/',           requirePermission('promotions:manage'), PromotionsCntlr.list);
router.post('/',          requirePermission('promotions:manage'), PromotionsCntlr.create);
router.put('/:promo_no',  requirePermission('promotions:manage'), PromotionsCntlr.update);

module.exports = router;
