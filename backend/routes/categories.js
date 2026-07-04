'use strict';

const express           = require('express');
const router            = express.Router();
const requirePermission = require('../middleware/requirePermission');
const CategoriesCntlr   = require('../controllers/CategoriesCntlr')();

// Reads stay open to any authenticated user — the storefront browses these.
router.get('/',       CategoriesCntlr.find);
router.get('/:id',    CategoriesCntlr.findOne);
router.post('/',      requirePermission('catalog:write'), CategoriesCntlr.create);
router.put('/:id',    requirePermission('catalog:write'), CategoriesCntlr.update);
router.delete('/:id', requirePermission('catalog:write'), CategoriesCntlr.remove);

module.exports = router;
