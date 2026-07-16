'use strict';

const express    = require('express');
const router     = express.Router();
const { guard }  = require('../config/routePermissions');
const RolesCntlr = require('../controllers/RolesCntlr')();

// Every endpoint needs roles:manage — editing roles/permissions is privilege
// escalation, admin-only by default.

// Must be registered before /:code so 'permissions' is not parsed as a role
router.get('/permissions',       guard('GET /api/v1/roles/permissions'),       RolesCntlr.listPermissions);

router.get('/',                  guard('GET /api/v1/roles'),                   RolesCntlr.find);
router.post('/',                 guard('POST /api/v1/roles'),                  RolesCntlr.create);
router.put('/:code',             guard('PUT /api/v1/roles/:code'),             RolesCntlr.update);
router.put('/:code/permissions', guard('PUT /api/v1/roles/:code/permissions'), RolesCntlr.setPermissions);
router.delete('/:code',          guard('DELETE /api/v1/roles/:code'),          RolesCntlr.remove);

module.exports = router;
