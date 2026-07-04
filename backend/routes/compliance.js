'use strict';

const express           = require('express');
const router            = express.Router();
const requirePermission = require('../middleware/requirePermission');
const ComplianceCntlr   = require('../controllers/ComplianceCntlr')();

// Any authenticated user files for their own email (staff may file for others)
router.post('/requests', ComplianceCntlr.createRequest);

// Staff review queue
router.get('/requests',  requirePermission('customers:write'), ComplianceCntlr.list);

module.exports = router;
