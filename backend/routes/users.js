'use strict';

const express           = require('express');
const router            = express.Router();
const requirePermission = require('../middleware/requirePermission');
const UsersCntlr        = require('../controllers/UsersCntlr')();

// All user management requires users:manage (held by the admin role)
router.use(requirePermission('users:manage'));

// Must be registered before /:id so 'roles' is not parsed as a user id
router.get('/roles',              UsersCntlr.listRoles);

router.post('/',                  UsersCntlr.createUser);
router.get('/',                   UsersCntlr.find);
router.get('/:id',                UsersCntlr.findOne);
router.put('/:id',                UsersCntlr.update);
router.delete('/:id',             UsersCntlr.deactivate);

router.post('/:id/roles',         UsersCntlr.grantRole);
router.delete('/:id/roles/:role', UsersCntlr.revokeRole);

module.exports = router;
