'use strict';

const Reports = require('../models/reports');

const ReportsCntlr = function () {

    const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

    return { cogs, valuation, shrinkage, reservations, salesSummary };

    /** Parses ?from/?to with sane defaults (last 30 days). */
    function dateRange(req, next) {
        const today = new Date().toISOString().slice(0, 10);
        const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const from = req.query.from || monthAgo;
        const to   = req.query.to   || today;
        if (!DATE_REGEX.test(from) || !DATE_REGEX.test(to)) {
            next({ status: 400, message: 'from/to must be YYYY-MM-DD' });
            return null;
        }
        return { from, to };
    }

    function respond(res, next, key, promise, extra = {}) {
        promise
            .then(rows => {
                res.locals.results = { [key]: rows, ...extra };
                res.locals.status  = 200;
                res.locals.message = `${key} report`;
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message || 'Report failed' }));
    }

    // GET /api/v1/reports/cogs?from&to&group_by=product|category|day|month
    function cogs(req, res, next) {
        const range = dateRange(req, next);
        if (!range) return;
        const groupBy = req.query.group_by || 'product';
        respond(res, next, 'cogs', Reports.cogs({ ...range, groupBy }), { ...range, group_by: groupBy });
    }

    // GET /api/v1/reports/valuation?warehouse_no=
    function valuation(req, res, next) {
        const warehouseNo = req.query.warehouse_no ? parseInt(req.query.warehouse_no, 10) : null;
        if (req.query.warehouse_no && isNaN(warehouseNo)) {
            return next({ status: 400, message: 'Invalid warehouse_no' });
        }
        respond(res, next, 'valuation', Reports.valuation({ warehouseNo }));
    }

    // GET /api/v1/reports/shrinkage?from&to
    function shrinkage(req, res, next) {
        const range = dateRange(req, next);
        if (!range) return;
        respond(res, next, 'shrinkage', Reports.shrinkage(range), range);
    }

    // GET /api/v1/reports/reservations
    function reservations(req, res, next) {
        respond(res, next, 'reservations', Reports.reservations());
    }

    // GET /api/v1/reports/sales-summary?from&to
    function salesSummary(req, res, next) {
        const range = dateRange(req, next);
        if (!range) return;
        respond(res, next, 'sales_summary', Reports.salesSummary(range), range);
    }

};

module.exports = ReportsCntlr;
