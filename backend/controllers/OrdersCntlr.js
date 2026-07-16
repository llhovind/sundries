'use strict';

const Orders             = require('../models/orders');
const Rbac               = require('../models/rbac');
const FulfillmentService = require('../services/fulfillmentService');
const Pagination         = require('../common/pagination');

const OrdersCntlr = function () {

    return { list, findOne, ship };

    /** Loads req.user.perms when the token predates the perms claim. */
    async function perms(req) {
        if (!Array.isArray(req.user.perms)) {
            req.user.perms = await Rbac.getPermissionsForUser(req.user.id);
        }
        return req.user.perms;
    }

    // GET /api/v1/orders — staff (orders:read) see all; customers see their own
    async function list(req, res, next) {
        try {
            const staff = (await perms(req)).includes('orders:read');
            const { page, pageSize, offset } = Pagination.parsePageQuery(req.query);
            const { rows, total } = await Orders.list({
                userId: req.user.id, staff,
                status: req.query.status || null,
                limit: pageSize, offset,
            });
            res.locals.results = Pagination.pageResult('orders', rows, total, page, pageSize);
            res.locals.status  = 200;
            res.locals.message = 'Orders returned';
            next();
        } catch (err) {
            next({ status: 500, message: 'Failed to load orders' });
        }
    }

    // GET /api/v1/orders/:ord_no
    async function findOne(req, res, next) {
        const ordNo = parseInt(req.params.ord_no, 10);
        if (isNaN(ordNo)) return next({ status: 400, message: 'Invalid order number' });
        try {
            const staff = (await perms(req)).includes('orders:read');
            const order = await Orders.findOne(ordNo, { userId: req.user.id, staff });
            if (!order) return next({ status: 404, message: 'Order not found' });
            res.locals.results = { order };
            res.locals.status  = 200;
            res.locals.message = 'Order returned';
            next();
        } catch (err) {
            next({ status: 500, message: 'Failed to load order' });
        }
    }

    // POST /api/v1/orders/:ord_no/ship — capture-on-fulfillment + transition
    async function ship(req, res, next) {
        const ordNo = parseInt(req.params.ord_no, 10);
        if (isNaN(ordNo)) return next({ status: 400, message: 'Invalid order number' });
        try {
            const result = await FulfillmentService.shipOrder(ordNo, req.user.id);
            res.locals.results = result;
            res.locals.status  = 200;
            res.locals.message = result.status === 'partially_shipped'
                ? 'Ready lines shipped — backordered items remain outstanding'
                : 'Order shipped and payment captured';
            next();
        } catch (err) {
            next({ status: err.status || 500, message: err.message || 'Ship failed' });
        }
    }

};

module.exports = OrdersCntlr;
