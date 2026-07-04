'use strict';

const PromotionService = require('../services/promotionService');
const Pagination       = require('../common/pagination');

const PromotionsCntlr = function () {

    return { list, create, update, validate };

    // GET /api/v1/promotions
    function list(req, res, next) {
        const { page, pageSize, offset } = Pagination.parsePageQuery(req.query);
        PromotionService.list({ status: req.query.status || null, limit: pageSize, offset })
            .then(({ rows, total }) => {
                res.locals.results = Pagination.pageResult('promotions', rows, total, page, pageSize);
                res.locals.status  = 200;
                res.locals.message = 'Promotions returned';
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

    // POST /api/v1/promotions
    function create(req, res, next) {
        Promise.resolve()
            .then(() => PromotionService.create(req.body || {}, req.user.id))
            .then(promo => {
                res.locals.results = { promotion: promo };
                res.locals.status  = 201;
                res.locals.message = 'Promotion created';
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

    // PUT /api/v1/promotions/:promo_no
    function update(req, res, next) {
        const promoNo = parseInt(req.params.promo_no, 10);
        if (isNaN(promoNo)) return next({ status: 400, message: 'Invalid promo_no' });
        Promise.resolve()
            .then(() => PromotionService.update(promoNo, req.body || {}, req.user.id))
            .then(promo => {
                if (!promo) return next({ status: 404, message: 'Promotion not found' });
                res.locals.results = { promotion: promo };
                res.locals.status  = 200;
                res.locals.message = 'Promotion updated';
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

    // POST /api/v1/promotions/validate — customer-facing pre-check for the cart
    function validate(req, res, next) {
        const { code, subtotal } = req.body || {};
        if (!code) return next({ status: 400, message: 'code is required' });
        PromotionService.validate(code, { subtotal: Number(subtotal) || 0 })
            .then(result => {
                res.locals.results = { promotion: result };
                res.locals.status  = 200;
                res.locals.message = 'Promotion valid';
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

};

module.exports = PromotionsCntlr;
