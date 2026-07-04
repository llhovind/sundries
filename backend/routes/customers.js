'use strict';

const express           = require('express');
const router            = express.Router();
const requirePermission = require('../middleware/requirePermission');
const CustomersCntlr    = require('../controllers/CustomersCntlr')();

// Self-service: any authenticated user manages their own profile
router.get('/me',  CustomersCntlr.getMe);
router.put('/me',  CustomersCntlr.upsertMe);
// After any /me handler calls next(), exit this router so /:id never matches /me
router.all('/me',  (_req, _res, next) => next('router'));

// Staff access to customer accounts
router.get('/',    requirePermission('customers:read'),  CustomersCntlr.find);
router.get('/:id', requirePermission('customers:read'),  CustomersCntlr.findOne);
router.post('/',   requirePermission('customers:write'), CustomersCntlr.create);
router.put('/:id', requirePermission('customers:write'), CustomersCntlr.update);

module.exports = router;
