'use strict';

const express           = require('express');
const router            = express.Router();
const { guard }         = require('../config/routePermissions');
const CategoriesCntlr   = require('../controllers/CategoriesCntlr')();

// Reads are public — the storefront (including anonymous guests) browses these.
router.get('/',       CategoriesCntlr.find);
router.get('/:id',    CategoriesCntlr.findOne);
router.post('/',      guard('POST /api/v1/categories'),      CategoriesCntlr.create);
router.put('/:id',    guard('PUT /api/v1/categories/:id'),   CategoriesCntlr.update);
router.delete('/:id', guard('DELETE /api/v1/categories/:id'), CategoriesCntlr.remove);

module.exports = router;
