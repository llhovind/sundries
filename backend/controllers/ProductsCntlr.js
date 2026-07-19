'use strict';

const Products     = require('../models/products');
const Rbac         = require('../models/rbac');
const Pagination   = require('../common/pagination');
const ImageStorage = require('../services/imageStorage');
const { log }      = require('../common/logger');

const ProductsCntlr = function () {

    return { list, findOne, create, update, upsertVariant, setOptions, uploadImage, uploadVariantImage };

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

    /**
     * Shared image-swap sequence: write the new file, point the DB at it
     * (rolling the file back if that fails), then drop the replaced file —
     * so disk and DB cannot drift apart.
     */
    async function swapImage({ save, persist, previous, logContext }) {
        const stored = await save();
        try {
            await persist(stored);
        } catch (err) {
            await ImageStorage.removeImage(stored).catch(() => {});
            throw err;
        }
        if (previous && previous !== stored) {
            await ImageStorage.removeImage(previous).catch(err =>
                log('warn', 'failed to remove replaced image', { ...logContext, image: previous, error: err }));
        }
        return stored;
    }

    /** Stores an uploaded image (req.file, from the imageUpload middleware) as the product's primary_image. */
    async function uploadImage(req, res, next) {
        const productNo = parseInt(req.params.product_no, 10);
        if (isNaN(productNo)) return next({ status: 400, message: 'Invalid product_no' });
        if (!req.file) return next({ status: 400, message: 'An "image" file field is required' });
        try {
            const product = await Products.findOne(productNo, { includeInactive: true });
            if (!product) return next({ status: 404, message: 'Product not found' });

            const stored = await swapImage({
                save:       () => ImageStorage.saveProductImage(productNo, req.file.mimetype, req.file.buffer),
                persist:    s  => Products.update(productNo, { primary_image: s }, req.user.id),
                previous:   product.primary_image,
                logContext: { productNo },
            });
            res.locals.results = { product_no: productNo, primary_image: stored };
            res.locals.status  = 200;
            res.locals.message = 'Product image saved';
            next();
        } catch (err) {
            next({ status: err.status || 500, message: err.message || 'Failed to save product image' });
        }
    }

    /** Same as uploadImage, scoped to one variant's primary_image. */
    async function uploadVariantImage(req, res, next) {
        const productNo = parseInt(req.params.product_no, 10);
        const variantNo = parseInt(req.params.variant_no, 10);
        if (isNaN(productNo) || isNaN(variantNo)) {
            return next({ status: 400, message: 'Invalid product_no or variant_no' });
        }
        if (!req.file) return next({ status: 400, message: 'An "image" file field is required' });
        try {
            const variant = await Products.findVariant(productNo, variantNo);
            if (!variant) return next({ status: 404, message: 'Variant not found' });

            const stored = await swapImage({
                save:       () => ImageStorage.saveVariantImage(productNo, variantNo, req.file.mimetype, req.file.buffer),
                persist:    s  => Products.setVariantImage(productNo, variantNo, s, req.user.id),
                previous:   variant.primary_image,
                logContext: { productNo, variantNo },
            });
            res.locals.results = { product_no: productNo, variant_no: variantNo, primary_image: stored };
            res.locals.status  = 200;
            res.locals.message = 'Variant image saved';
            next();
        } catch (err) {
            next({ status: err.status || 500, message: err.message || 'Failed to save variant image' });
        }
    }

    /** Shape check only — combination rules (one value per option, uniqueness) live in the model. */
    function invalidValueNos(valueNos) {
        if (valueNos === undefined) return null;
        if (!Array.isArray(valueNos) || valueNos.some(v => !Number.isInteger(Number(v)) || Number(v) <= 0)) {
            return 'valueNos must be an array of option value ids';
        }
        return null;
    }

    /** Shape check for the options payload: unique non-empty names, unique non-empty values. */
    function invalidOptions(options) {
        const names = new Set();
        for (const opt of options) {
            if (!opt || typeof opt.name !== 'string' || !opt.name.trim()) {
                return 'each option requires a non-empty name';
            }
            const name = opt.name.trim();
            if (names.has(name)) return `duplicate option "${name}"`;
            names.add(name);
            if (opt.values !== undefined && !Array.isArray(opt.values)) {
                return `values of option "${name}" must be an array`;
            }
            const values = new Set();
            for (const value of opt.values || []) {
                if (typeof value !== 'string' || !value.trim()) {
                    return `option "${name}" has an empty value`;
                }
                if (values.has(value.trim())) return `option "${name}" has duplicate value "${value.trim()}"`;
                values.add(value.trim());
            }
        }
        return null;
    }

    function upsertVariant(req, res, next) {
        const productNo = parseInt(req.params.product_no, 10);
        if (isNaN(productNo)) return next({ status: 400, message: 'Invalid product_no' });
        const shapeError = invalidValueNos(req.body?.valueNos);
        if (shapeError) return next({ status: 400, message: shapeError });
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
        const shapeError = invalidOptions(options);
        if (shapeError) return next({ status: 400, message: shapeError });
        const normalized = options.map(o => ({
            name:   o.name.trim(),
            values: (o.values || []).map(v => v.trim()),
        }));
        Products.setOptions(productNo, normalized, req.user.id)
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
