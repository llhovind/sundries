'use strict';

const Products   = require('../models/products');
const Rbac       = require('../models/rbac');
const Pagination = require('../common/pagination');

const ProductsCntlr = function () {

    return { list, findOne, create, update, upsertVariant, setOptions };

    /** Staff (catalog:write) see inactive/draft products; shoppers and anonymous guests do not. */
    async function canSeeInactive(req) {
        if (!req.user) return false;
        if (!Array.isArray(req.user.perms)) {
            req.user.perms = await Rbac.getPermissionsForUser(req.user.id);
        }
        return req.user.perms.includes('catalog:write');
    }

    async function list(req, res, next) {
        try {
            const includeInactive = await canSeeInactive(req);
            const { page, pageSize, offset } = Pagination.parsePageQuery(req.query);
            const { rows, total } = await Products.list({
                search: req.query.q || null,
                status: includeInactive ? (req.query.status || null) : null,
                includeInactive,
                limit: pageSize, offset,
            });
            res.locals.results = Pagination.pageResult('products', rows, total, page, pageSize);
            res.locals.status  = 200;
            res.locals.message = 'Products returned';
            next();
        } catch (err) {
            next({ status: err.status || 500, message: err.message || 'Failed to load products' });
        }
    }

    async function findOne(req, res, next) {
        const productNo = parseInt(req.params.product_no, 10);
        if (isNaN(productNo)) return next({ status: 400, message: 'Invalid product_no' });
        try {
            const includeInactive = await canSeeInactive(req);
            const product = await Products.findOne(productNo, { includeInactive });
            if (!product) return next({ status: 404, message: 'Product not found' });
            res.locals.results = { product };
            res.locals.status  = 200;
            res.locals.message = 'Product returned';
            next();
        } catch (err) {
            next({ status: err.status || 500, message: err.message || 'Failed to load product' });
        }
    }

    function create(req, res, next) {
        Promise.resolve()
            .then(() => Products.create(req.body || {}, req.user.id))
            .then(productNo => {
                res.locals.results = { product_no: productNo };
                res.locals.status  = 201;
                res.locals.message = 'Product created';
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

    function update(req, res, next) {
        const productNo = parseInt(req.params.product_no, 10);
        if (isNaN(productNo)) return next({ status: 400, message: 'Invalid product_no' });
        Promise.resolve()
            .then(() => Products.update(productNo, req.body || {}, req.user.id))
            .then(updated => {
                if (!updated) return next({ status: 404, message: 'Product not found' });
                res.locals.results = { product_no: updated };
                res.locals.status  = 200;
                res.locals.message = 'Product updated';
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

    function upsertVariant(req, res, next) {
        const productNo = parseInt(req.params.product_no, 10);
        if (isNaN(productNo)) return next({ status: 400, message: 'Invalid product_no' });
        Promise.resolve()
            .then(() => Products.upsertVariant(productNo, req.body || {}, req.user.id))
            .then(variantNo => {
                res.locals.results = { variant_no: variantNo };
                res.locals.status  = req.body?.variant_no ? 200 : 201;
                res.locals.message = 'Variant saved';
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

    function setOptions(req, res, next) {
        const productNo = parseInt(req.params.product_no, 10);
        if (isNaN(productNo)) return next({ status: 400, message: 'Invalid product_no' });
        const { options } = req.body || {};
        if (!Array.isArray(options)) return next({ status: 400, message: 'options array is required' });
        Products.setOptions(productNo, options, req.user.id)
            .then(() => {
                res.locals.results = { product_no: productNo };
                res.locals.status  = 200;
                res.locals.message = 'Options saved';
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

};

module.exports = ProductsCntlr;
