'use strict';

const express       = require('express');
const router        = express.Router();
const { guard }     = require('../config/routePermissions');
const SettingsCntlr = require('../controllers/SettingsCntlr')();

// Store configuration — one permission (settings:manage) covers the whole
// surface, matching its seeded description: "Store settings, shipping rules,
// tax tables, warehouses". Admin-only by default.

// App settings values (keys are code-defined; edit-only)
router.get('/values',      guard('GET /api/v1/settings/values'),      SettingsCntlr.findValues);
router.put('/values/:key', guard('PUT /api/v1/settings/values/:key'), SettingsCntlr.updateValue);

// Shipping: subtotal rules + weight surcharge bands
router.get('/shipping-rules',           guard('GET /api/v1/settings/shipping-rules'),          SettingsCntlr.rules.find);
router.post('/shipping-rules',          guard('POST /api/v1/settings/shipping-rules'),         SettingsCntlr.rules.create);
router.put('/shipping-rules/:rule_no',  guard('PUT /api/v1/settings/shipping-rules/:rule_no'), SettingsCntlr.rules.update);
router.get('/weight-bands',             guard('GET /api/v1/settings/weight-bands'),            SettingsCntlr.bands.find);
router.post('/weight-bands',            guard('POST /api/v1/settings/weight-bands'),           SettingsCntlr.bands.create);
router.put('/weight-bands/:band_no',    guard('PUT /api/v1/settings/weight-bands/:band_no'),   SettingsCntlr.bands.update);

// Tax rates (local tax provider table)
router.get('/tax-rates',           guard('GET /api/v1/settings/tax-rates'),          SettingsCntlr.taxRates.find);
router.post('/tax-rates',          guard('POST /api/v1/settings/tax-rates'),         SettingsCntlr.taxRates.create);
router.put('/tax-rates/:rate_no',  guard('PUT /api/v1/settings/tax-rates/:rate_no'), SettingsCntlr.taxRates.update);

// Warehouses
router.get('/warehouses',                guard('GET /api/v1/settings/warehouses'),               SettingsCntlr.warehouses.find);
router.post('/warehouses',               guard('POST /api/v1/settings/warehouses'),              SettingsCntlr.warehouses.create);
router.put('/warehouses/:warehouse_no',  guard('PUT /api/v1/settings/warehouses/:warehouse_no'), SettingsCntlr.warehouses.update);

module.exports = router;
