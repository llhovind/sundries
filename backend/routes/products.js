'use strict';

const express           = require('express');
const router            = express.Router();
const requirePermission = require('../middleware/requirePermission');
const ProductsCntlr     = require('../controllers/ProductsCntlr')();

// Reads: public — anonymous guests browse the storefront; staff additionally
// see inactive/draft products (decided in the controller via catalog:write).
router.get('/',                        ProductsCntlr.list);
router.get('/:product_no',             ProductsCntlr.findOne);

// Catalog management
router.post('/',                       requirePermission('catalog:write'), ProductsCntlr.create);
router.put('/:product_no',             requirePermission('catalog:write'), ProductsCntlr.update);
router.post('/:product_no/variants',   requirePermission('catalog:write'), ProductsCntlr.upsertVariant);
router.put('/:product_no/options',     requirePermission('catalog:write'), ProductsCntlr.setOptions);

module.exports = router;
