'use strict';

const express           = require('express');
const router            = express.Router();
const requirePermission = require('../middleware/requirePermission');
const ReportsCntlr      = require('../controllers/ReportsCntlr')();

// Cost-bearing reports need reports:cogs (admin + finance by default).
router.get('/cogs',          requirePermission('reports:cogs'), ReportsCntlr.cogs);
router.get('/valuation',     requirePermission('reports:cogs'), ReportsCntlr.valuation);
router.get('/shrinkage',     requirePermission('reports:cogs'), ReportsCntlr.shrinkage);

// Operational reports: any role holding reports:view.
router.get('/reservations',  requirePermission('reports:view'), ReportsCntlr.reservations);
router.get('/sales-summary', requirePermission('reports:view'), ReportsCntlr.salesSummary);

module.exports = router;
