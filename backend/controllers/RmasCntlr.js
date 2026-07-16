'use strict';

const RmaService = require('../services/rmaService');
const Rbac       = require('../models/rbac');
const Pagination = require('../common/pagination');

const RmasCntlr = function () {

    return { request, list, findOne, updateStatus, receive, refund };

    async function isStaff(req) {
        if (!Array.isArray(req.user.perms)) {
            req.user.perms = await Rbac.getPermissionsForUser(req.user.id);
        }
        return req.user.perms.includes('rma:manage');
    }

    // POST /api/v1/rmas — customer opens a return on their own order
    async function request(req, res, next) {
        try {
            const staff = await isStaff(req);
            const rmaNo = await RmaService.request(req.body || {}, { userId: req.user.id, staff });
            res.locals.results = { rma_no: rmaNo, status: 'requested' };
            res.locals.status  = 201;
            res.locals.message = 'Return requested';
            next();
        } catch (err) {
            next({ status: err.status || 500, message: err.message });
        }
    }

    // GET /api/v1/rmas — staff see all; customers their own
    async function list(req, res, next) {
        try {
            const staff = await isStaff(req);
            const { page, pageSize, offset } = Pagination.parsePageQuery(req.query);
            const { rows, total } = await RmaService.list({
                status: req.query.status || null,
                userId: req.user.id, staff, limit: pageSize, offset,
            });
            res.locals.results = Pagination.pageResult('rmas', rows, total, page, pageSize);
            res.locals.status  = 200;
            res.locals.message = 'RMAs returned';
            next();
        } catch (err) {
            next({ status: err.status || 500, message: err.message });
        }
    }

    // GET /api/v1/rmas/:rma_no
    async function findOne(req, res, next) {
        const rmaNo = parseInt(req.params.rma_no, 10);
        if (isNaN(rmaNo)) return next({ status: 400, message: 'Invalid rma_no' });
        try {
            const staff = await isStaff(req);
            const rma = await RmaService.findOne(rmaNo, { userId: req.user.id, staff });
            if (!rma) return next({ status: 404, message: 'RMA not found' });
            res.locals.results = { rma };
            res.locals.status  = 200;
            res.locals.message = 'RMA returned';
            next();
        } catch (err) {
            next({ status: err.status || 500, message: err.message });
        }
    }

    // PUT /api/v1/rmas/:rma_no/status — approve / reject / close (rma:manage)
    function updateStatus(req, res, next) {
        const rmaNo = parseInt(req.params.rma_no, 10);
        if (isNaN(rmaNo)) return next({ status: 400, message: 'Invalid rma_no' });
        const { status, notes } = req.body || {};
        if (!status) return next({ status: 400, message: 'status is required' });

        RmaService.updateStatus(rmaNo, status, req.user.id, notes)
            .then(rma => {
                res.locals.results = { rma };
                res.locals.status  = 200;
                res.locals.message = `RMA ${rma.status}`;
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

    // POST /api/v1/rmas/:rma_no/receive — record goods back, restock per line (rma:manage)
    function receive(req, res, next) {
        const rmaNo = parseInt(req.params.rma_no, 10);
        if (isNaN(rmaNo)) return next({ status: 400, message: 'Invalid rma_no' });
        const { lines } = req.body || {};
        if (!Array.isArray(lines) || !lines.length) {
            return next({ status: 400, message: 'lines[{rma_line_id, restock}] are required' });
        }
        RmaService.receive(rmaNo, lines, req.user.id)
            .then(result => {
                res.locals.results = result;
                res.locals.status  = 200;
                res.locals.message = 'Return received';
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

    // POST /api/v1/rmas/:rma_no/refund — Finance credits the sale (refunds:create).
    // amount is optional: it defaults to what the customer paid for the
    // returned lines (prorated discount and tax included).
    function refund(req, res, next) {
        const rmaNo = parseInt(req.params.rma_no, 10);
        if (isNaN(rmaNo)) return next({ status: 400, message: 'Invalid rma_no' });
        const { amount, reason } = req.body || {};
        RmaService.refund(rmaNo, amount != null ? Number(amount) : null, reason || 'RMA refund', req.user.id)
            .then(result => {
                res.locals.results = result;
                res.locals.status  = 201;
                res.locals.message = 'RMA refunded';
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

};

module.exports = RmasCntlr;
