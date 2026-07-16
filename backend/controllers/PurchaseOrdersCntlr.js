'use strict';

const PurchasingService = require('../services/purchasingService');
const Pagination        = require('../common/pagination');

/**
 * Purchase orders — raise, receive against, close, cancel. All domain rules
 * live in PurchasingService; route-level permission guards are in
 * routes/purchaseOrders.js.
 */
const PurchaseOrdersCntlr = function () {

    return { list, findOne, create, receive, close, cancel };

    // GET /api/v1/purchase-orders?status=&vendor_id=&page=&pageSize=
    async function list(req, res, next) {
        try {
            const { page, pageSize, offset } = Pagination.parsePageQuery(req.query);
            const vendorId = req.query.vendor_id ? parseInt(req.query.vendor_id, 10) : null;
            const { rows, total } = await PurchasingService.list({
                status: req.query.status || null,
                vendorId: Number.isNaN(vendorId) ? null : vendorId,
                limit: pageSize, offset,
            });
            res.locals.results = Pagination.pageResult('purchase_orders', rows, total, page, pageSize);
            res.locals.status  = 200;
            res.locals.message = 'Purchase orders returned';
            next();
        } catch (err) {
            next({ status: 500, message: 'Failed to load purchase orders' });
        }
    }

    // GET /api/v1/purchase-orders/:po_no
    async function findOne(req, res, next) {
        const poNo = parseInt(req.params.po_no, 10);
        if (isNaN(poNo)) return next({ status: 400, message: 'Invalid PO number' });
        try {
            const po = await PurchasingService.findOne(poNo);
            if (!po) return next({ status: 404, message: 'Purchase order not found' });
            res.locals.results = { purchase_order: po };
            res.locals.status  = 200;
            res.locals.message = 'Purchase order returned';
            next();
        } catch (err) {
            next({ status: 500, message: 'Failed to load purchase order' });
        }
    }

    // POST /api/v1/purchase-orders — raise an open PO with lines
    function create(req, res, next) {
        PurchasingService.create(req.body || {}, req.user.id)
            .then(poNo => {
                res.locals.results = { po_no: poNo, po_status: 'open' };
                res.locals.status  = 201;
                res.locals.message = 'Purchase order created';
                next();
            })
            .catch(err => next({ status: err.status || 400, message: err.message }));
    }

    // POST /api/v1/purchase-orders/:po_no/receive  { lines: [{po_line_id, qty}] }
    function receive(req, res, next) {
        const poNo = parseInt(req.params.po_no, 10);
        if (isNaN(poNo)) return next({ status: 400, message: 'Invalid PO number' });
        PurchasingService.receive(poNo, (req.body || {}).lines || [], req.user.id)
            .then(result => {
                res.locals.results = result;
                res.locals.status  = 200;
                res.locals.message = 'Receipt recorded';
                next();
            })
            .catch(err => next({ status: err.status || 400, message: err.message }));
    }

    // POST /api/v1/purchase-orders/:po_no/close
    function close(req, res, next) {
        return transition(req, res, next, PurchasingService.close, 'closed');
    }

    // POST /api/v1/purchase-orders/:po_no/cancel
    function cancel(req, res, next) {
        return transition(req, res, next, PurchasingService.cancel, 'cancelled');
    }

    function transition(req, res, next, action, toStatus) {
        const poNo = parseInt(req.params.po_no, 10);
        if (isNaN(poNo)) return next({ status: 400, message: 'Invalid PO number' });
        action(poNo, req.user.id)
            .then(no => {
                res.locals.results = { po_no: no, po_status: toStatus };
                res.locals.status  = 200;
                res.locals.message = `Purchase order ${toStatus}`;
                next();
            })
            .catch(err => next({ status: err.status || 400, message: err.message }));
    }

};

module.exports = PurchaseOrdersCntlr;
