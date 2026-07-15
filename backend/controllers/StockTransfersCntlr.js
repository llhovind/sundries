'use strict';

const StockTransferService = require('../services/stockTransferService');
const Pagination           = require('../common/pagination');

/**
 * Stock transfers — warehouse → transport → warehouse movements.
 * Reads need inventory:read; lifecycle actions need inventory:transfer
 * (route-level guards). All inventory effects live in the service/DB.
 */
const StockTransfersCntlr = function () {

    return { list, findOne, create, dispatch, receive, cancel };

    // GET /api/v1/inventory/transfers?status=&page=&pageSize=
    async function list(req, res, next) {
        try {
            const { page, pageSize, offset } = Pagination.parsePageQuery(req.query);
            const { rows, total } = await StockTransferService.list({
                status: req.query.status || null,
                limit: pageSize, offset,
            });
            res.locals.results = Pagination.pageResult('transfers', rows, total, page, pageSize);
            res.locals.status  = 200;
            res.locals.message = 'Transfers returned';
            next();
        } catch (err) {
            next({ status: 500, message: 'Failed to load transfers' });
        }
    }

    // GET /api/v1/inventory/transfers/:transfer_no
    async function findOne(req, res, next) {
        const transferNo = parseInt(req.params.transfer_no, 10);
        if (isNaN(transferNo)) return next({ status: 400, message: 'Invalid transfer number' });
        try {
            const transfer = await StockTransferService.findOne(transferNo);
            if (!transfer) return next({ status: 404, message: 'Transfer not found' });
            res.locals.results = { transfer };
            res.locals.status  = 200;
            res.locals.message = 'Transfer returned';
            next();
        } catch (err) {
            next({ status: 500, message: 'Failed to load transfer' });
        }
    }

    // POST /api/v1/inventory/transfers — create a draft with lines
    function create(req, res, next) {
        const { from_warehouse_no, to_warehouse_no, transport_warehouse_no,
                carrier, manifest_id, billing_no, tracking_no, notes, lines = [] } = req.body || {};

        StockTransferService.create({
            fromWarehouseNo:      from_warehouse_no,
            toWarehouseNo:        to_warehouse_no,
            transportWarehouseNo: transport_warehouse_no,
            carrier, manifestId: manifest_id, billingNo: billing_no,
            trackingNo: tracking_no, notes,
            lines: lines.map(ln => ({ variantNo: ln.variant_no, qty: Number(ln.qty) })),
        }, req.user.id)
            .then(transferNo => {
                res.locals.results = { transfer_no: transferNo, status: 'draft' };
                res.locals.status  = 201;
                res.locals.message = 'Transfer created';
                next();
            })
            .catch(err => next({ status: err.status || 400, message: err.message }));
    }

    // POST /api/v1/inventory/transfers/:transfer_no/dispatch
    function dispatch(req, res, next) {
        return transition(req, res, next, StockTransferService.dispatch, 'dispatched');
    }

    // POST /api/v1/inventory/transfers/:transfer_no/receive
    function receive(req, res, next) {
        return transition(req, res, next, StockTransferService.receive, 'received');
    }

    // POST /api/v1/inventory/transfers/:transfer_no/cancel
    function cancel(req, res, next) {
        return transition(req, res, next, StockTransferService.cancel, 'cancelled');
    }

    /** Shared handler for the three lifecycle actions. */
    function transition(req, res, next, action, toStatus) {
        const transferNo = parseInt(req.params.transfer_no, 10);
        if (isNaN(transferNo)) return next({ status: 400, message: 'Invalid transfer number' });
        action(transferNo, req.user.id)
            .then(no => {
                res.locals.results = { transfer_no: no, status: toStatus };
                res.locals.status  = 200;
                res.locals.message = `Transfer ${toStatus}`;
                next();
            })
            // Includes DB-guard failures (e.g. dispatching more than the origin
            // has unreserved) — the message states the constraint that failed.
            .catch(err => next({ status: err.status || 400, message: err.message }));
    }

};

module.exports = StockTransfersCntlr;
