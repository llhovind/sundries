'use strict';

const Utils         = require('../common/utils');
const AppSettings   = require('../models/appSettings');
const ShippingRules = require('../models/shippingRules');
const TaxRates      = require('../models/taxRates');
const Warehouses    = require('../models/warehouses');

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Store configuration controller: app settings values, shipping rules and
 * weight bands, tax rates, warehouses. All list/create/update handlers share
 * one factory — the resources differ only in model functions and names.
 */
const SettingsCntlr = function () {

    /** Map model/validation errors to HTTP: tagged 400s pass through,
     *  unique violations become 409, the rest are 500. */
    function toHttpError(err, fallbackMessage) {
        if (err.status) return { status: err.status, message: err.message };
        if (err.code === PG_UNIQUE_VIOLATION) {
            return { status: 409, message: `${fallbackMessage}: already exists` };
        }
        return { status: 500, message: Utils.evaluateError(err).message };
    }

    /** Build { find, create, update } handlers for one CRUD resource. */
    function crudHandlers({ list, create, update, singular, plural, idParam }) {
        return {
            find(req, res, next) {
                list()
                    .then(rows => {
                        res.locals.results = { [plural]: rows };
                        res.locals.status  = 200;
                        res.locals.message = `${plural} returned`;
                        next();
                    })
                    .catch(err => next(toHttpError(err, singular)));
            },
            create(req, res, next) {
                Promise.resolve()
                    .then(() => create(req.body, req.user.id))
                    .then(row => {
                        res.locals.results = { [singular]: row };
                        res.locals.status  = 201;
                        res.locals.message = `${singular} created`;
                        next();
                    })
                    .catch(err => next(toHttpError(err, singular)));
            },
            update(req, res, next) {
                const id = parseInt(req.params[idParam], 10);
                if (isNaN(id)) return next({ status: 400, message: `Invalid ${idParam}` });
                Promise.resolve()
                    .then(() => update(id, req.body, req.user.id))
                    .then(row => {
                        if (!row) return next({ status: 404, message: `${singular} not found` });
                        res.locals.results = { [singular]: row };
                        res.locals.status  = 200;
                        res.locals.message = `${singular} updated`;
                        next();
                    })
                    .catch(err => next(toHttpError(err, singular)));
            },
        };
    }

    const rules = crudHandlers({
        list: ShippingRules.findAllRules, create: ShippingRules.createRule, update: ShippingRules.updateRule,
        singular: 'rule', plural: 'rules', idParam: 'rule_no',
    });
    const bands = crudHandlers({
        list: ShippingRules.findAllBands, create: ShippingRules.createBand, update: ShippingRules.updateBand,
        singular: 'band', plural: 'bands', idParam: 'band_no',
    });
    const taxRates = crudHandlers({
        list: TaxRates.findAll, create: TaxRates.create, update: TaxRates.update,
        singular: 'rate', plural: 'rates', idParam: 'rate_no',
    });
    const warehouses = crudHandlers({
        list: Warehouses.findAll, create: Warehouses.create, update: Warehouses.update,
        singular: 'warehouse', plural: 'warehouses', idParam: 'warehouse_no',
    });

    // ── App settings values (edit-only: keys are code-defined) ───────────

    function findValues(req, res, next) {
        AppSettings.findAll()
            .then(settings => {
                res.locals.results = { settings };
                res.locals.status  = 200;
                res.locals.message = 'Settings returned';
                next();
            })
            .catch(err => next(toHttpError(err, 'setting')));
    }

    function updateValue(req, res, next) {
        Promise.resolve()
            .then(() => AppSettings.update(req.params.key, req.body.value, req.user.id))
            .then(setting => {
                if (!setting) return next({ status: 404, message: 'Unknown setting key' });
                res.locals.results = { setting };
                res.locals.status  = 200;
                res.locals.message = 'Setting updated';
                next();
            })
            .catch(err => next(toHttpError(err, 'setting')));
    }

    return { findValues, updateValue, rules, bands, taxRates, warehouses };
};

module.exports = SettingsCntlr;
