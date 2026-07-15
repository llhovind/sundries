'use strict';

const Carts = require('../models/carts');
const Utils = require('../common/utils');

/**
 * Cart controller — variant-based, self-serve. Checkout itself lives in
 * CheckoutCntlr; this only manages the open cart's contents. The old
 * quote/reconciliation endpoints were retired with the workflow.
 */
const CartsCntlr = function () {

    return { getCart, addItem, updateItem, removeItem };

    // GET /api/v1/cart
    function getCart(req, res, next) {
        Carts.getOrCreate(req.user.id)
            .then(cart => {
                res.locals.results = { cart };
                res.locals.status  = 200;
                res.locals.message = 'Cart returned';
                next();
            })
            .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
    }

    // POST /api/v1/cart/items  { variant_no, qty }
    function addItem(req, res, next) {
        const { variant_no, qty } = req.body || {};
        if (!variant_no)            return next({ status: 400, message: 'variant_no is required' });
        if (!(parseFloat(qty) > 0)) return next({ status: 400, message: 'qty must be greater than 0' });

        Carts.getOrCreate(req.user.id)
            .then(cart => Carts.addItem(cart.cart_no, variant_no, parseFloat(qty))
                .then(row => {
                    if (!row) return next({ status: 404, message: 'Product is not available' });
                    return Carts.findOpenCart(req.user.id).then(updated => {
                        res.locals.results = { cart: updated };
                        res.locals.status  = 200;
                        res.locals.message = 'Item added';
                        next();
                    });
                }))
            .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
    }

    // PUT /api/v1/cart/items/:variant_no  { qty }
    function updateItem(req, res, next) {
        const variantNo = parseInt(req.params.variant_no, 10);
        const qty       = parseFloat(req.body?.qty);
        if (isNaN(variantNo)) return next({ status: 400, message: 'Invalid variant_no' });
        if (!(qty > 0))       return next({ status: 400, message: 'qty must be greater than 0' });

        Carts.findOpenCart(req.user.id)
            .then(cart => {
                if (!cart) return next({ status: 404, message: 'No open cart found' });
                if (!cart.items.some(i => Number(i.variant_no) === variantNo)) {
                    return next({ status: 404, message: 'Item not in cart' });
                }
                return Carts.setItemQty(cart.cart_no, variantNo, qty)
                    .then(() => Carts.findOpenCart(req.user.id))
                    .then(updated => {
                        res.locals.results = { cart: updated };
                        res.locals.status  = 200;
                        res.locals.message = 'Item updated';
                        next();
                    });
            })
            .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
    }

    // DELETE /api/v1/cart/items/:variant_no
    function removeItem(req, res, next) {
        const variantNo = parseInt(req.params.variant_no, 10);
        if (isNaN(variantNo)) return next({ status: 400, message: 'Invalid variant_no' });

        Carts.findOpenCart(req.user.id)
            .then(cart => {
                if (!cart) return next({ status: 404, message: 'No open cart found' });
                return Carts.removeItem(cart.cart_no, variantNo)
                    .then(() => Carts.findOpenCart(req.user.id))
                    .then(updated => {
                        res.locals.results = { cart: updated };
                        res.locals.status  = 200;
                        res.locals.message = 'Item removed';
                        next();
                    });
            })
            .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
    }

};

module.exports = CartsCntlr;
