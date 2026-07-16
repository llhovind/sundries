'use strict';

const express           = require('express');
const router            = express.Router();
const { guard }         = require('../config/routePermissions');
const ReportsCntlr      = require('../controllers/ReportsCntlr')();

// Cost-bearing reports need reports:cogs (admin + finance by default).
router.get('/cogs',          guard('GET /api/v1/reports/cogs'),          ReportsCntlr.cogs);
router.get('/valuation',     guard('GET /api/v1/reports/valuation'),     ReportsCntlr.valuation);
router.get('/shrinkage',     guard('GET /api/v1/reports/shrinkage'),     ReportsCntlr.shrinkage);

// Operational reports: any role holding reports:view.
router.get('/reservations',  guard('GET /api/v1/reports/reservations'),  ReportsCntlr.reservations);
router.get('/sales-summary', guard('GET /api/v1/reports/sales-summary'), ReportsCntlr.salesSummary);

module.exports = router;
