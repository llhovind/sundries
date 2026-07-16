'use strict';

const express    = require('express');
const router     = express.Router();
const { guard }  = require('../config/routePermissions');
const UsersCntlr = require('../controllers/UsersCntlr')();

// Must be registered before /:id so 'roles' is not parsed as a user id
router.get('/roles',              guard('GET /api/v1/users/roles'),              UsersCntlr.listRoles);

router.post('/',                  guard('POST /api/v1/users'),                   UsersCntlr.createUser);
router.get('/',                   guard('GET /api/v1/users'),                    UsersCntlr.find);
router.get('/:id',                guard('GET /api/v1/users/:id'),                UsersCntlr.findOne);
router.put('/:id',                guard('PUT /api/v1/users/:id'),                UsersCntlr.update);
router.delete('/:id',             guard('DELETE /api/v1/users/:id'),             UsersCntlr.deactivate);

router.post('/:id/roles',         guard('POST /api/v1/users/:id/roles'),         UsersCntlr.grantRole);
router.delete('/:id/roles/:role', guard('DELETE /api/v1/users/:id/roles/:role'), UsersCntlr.revokeRole);

module.exports = router;
