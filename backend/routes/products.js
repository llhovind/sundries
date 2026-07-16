'use strict';

const express           = require('express');
const router            = express.Router();
const { guard }         = require('../config/routePermissions');
const ProductsCntlr     = require('../controllers/ProductsCntlr')();

// Reads: public — anonymous guests browse the storefront; staff additionally
// see inactive/draft products (decided in the controller via catalog:write).
router.get('/',                        ProductsCntlr.list);
router.get('/:product_no',             ProductsCntlr.findOne);

// Catalog management
router.post('/',                       guard('POST /api/v1/products'),                      ProductsCntlr.create);
router.put('/:product_no',             guard('PUT /api/v1/products/:product_no'),           ProductsCntlr.update);
router.post('/:product_no/variants',   guard('POST /api/v1/products/:product_no/variants'), ProductsCntlr.upsertVariant);
router.put('/:product_no/options',     guard('PUT /api/v1/products/:product_no/options'),   ProductsCntlr.setOptions);

module.exports = router;
