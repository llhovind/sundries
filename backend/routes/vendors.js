'use strict';

const express           = require('express');
const router            = express.Router();
const requirePermission = require('../middleware/requirePermission');
const VendorsCntlr      = require('../controllers/VendorsCntlr')();

// Vendors are staff data — previously readable by any authenticated user,
// now gated: purchasing owns vendors; inventory staff can look them up.
router.get('/',    requirePermission('purchasing:manage', 'inventory:read'), VendorsCntlr.find);
router.get('/:id', requirePermission('purchasing:manage', 'inventory:read'), VendorsCntlr.findOne);
router.post('/',   requirePermission('purchasing:manage'),                   VendorsCntlr.create);
router.put('/:id', requirePermission('purchasing:manage'),                   VendorsCntlr.update);

module.exports = router;
