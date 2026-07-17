'use strict';

const express       = require('express');
const router        = express.Router();
const { guard }     = require('../config/routePermissions');
const AuditLogCntlr = require('../controllers/AuditLogCntlr')();

// Audit trail of privileged actions — read-only by design (the table rejects
// UPDATE/DELETE via trigger; rows are written only by the DB audit triggers).
router.get('/',         guard('GET /api/v1/audit-log'),          AuditLogCntlr.find);
router.get('/entities', guard('GET /api/v1/audit-log/entities'), AuditLogCntlr.findEntities);

module.exports = router;
