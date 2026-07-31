'use strict';

const CheckoutService = require('../services/checkoutService');
const PaymentsService = require('../services/paymentsService');
const { isValidEmail } = require('../common/validation');

const CheckoutCntlr = function () {

    return { place, placeGuest, cancel };

    // POST /api/v1/checkout — place order from the authenticated user's open cart
    function place(req, res, next) {
        const { shipTo, backorders, notes, provider, promoCode } = req.body || {};
        CheckoutService.placeFromCart(req.user.id, { shipTo, backorders, notes, provider, promoCode })
            .then(result => {
                res.locals.results = { order: result };
                res.locals.status  = 201;
                res.locals.message = 'Order placed — awaiting payment confirmation';
                next();
            })
            .catch(err => nextCheckoutError(err, next));
    }

    // POST /api/v1/checkout/guest — guest checkout with inline items
    function placeGuest(req, res, next) {
        const { email, name, shipTo, items, backorders, notes, provider, promoCode } = req.body || {};
        if (!isValidEmail(email)) {
            return next({ status: 400, message: 'A valid email is required' });
        }
        CheckoutService.placeGuest({ email, name, shipTo, items, backorders, notes, provider, promoCode })
            .then(result => {
                res.locals.results = { order: result };
                res.locals.status  = 201;
                res.locals.message = 'Order placed — awaiting payment confirmation';
                next();
            })
            .catch(err => nextCheckoutError(err, next));
    }

    // POST /api/v1/checkout/:ord_no/cancel — owner, or staff with orders:cancel
    async function cancel(req, res, next) {
        const ordNo = parseInt(req.params.ord_no, 10);
        if (isNaN(ordNo)) return next({ status: 400, message: 'Invalid order number' });

        try {
            const Orders = require('../models/orders');
            const Rbac   = require('../models/rbac');
            if (!Array.isArray(req.user.perms)) {
                req.user.perms = await Rbac.getPermissionsForUser(req.user.id);
            }
            const staff = req.user.perms.includes('orders:cancel');
            const order = await Orders.findOne(ordNo, { userId: req.user.id, staff });
            if (!order) return next({ status: 404, message: 'Order not found' });

            await PaymentsService.cancelOrder(ordNo, req.user.id);
            res.locals.results = { ord_no: ordNo, status: 'cancelled' };
            res.locals.status  = 200;
            res.locals.message = 'Order cancelled';
            next();
        } catch (err) {
            next({ status: err.status || 500, message: err.message || 'Cancel failed' });
        }
    }

    /**
     * ReservationError carries per-line availability — surface it so the UI
     * can revert one step and offer remove / backorder / notify per line.
     */
    function nextCheckoutError(err, next) {
        if (err.name === 'ReservationError') {
            return next({
                status: 409,
                message: err.message,
                errors: err.failures.map(f =>
                    `variant ${f.variant_no}: requested ${f.qty}, available ${f.qty_available}`),
                failures: err.failures,
            });
        }
        next({ status: err.status || 500, message: err.message || 'Checkout failed' });
    }

};

module.exports = CheckoutCntlr;
