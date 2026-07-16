'use strict';

const express           = require('express');
const router            = express.Router();
const { guard }         = require('../config/routePermissions');
const ComplianceCntlr   = require('../controllers/ComplianceCntlr')();

// Any authenticated user files for their own email (staff may file for others)
router.post('/requests', ComplianceCntlr.createRequest);

// Staff review queue
router.get('/requests',  guard('GET /api/v1/compliance/requests'), ComplianceCntlr.list);

module.exports = router;
