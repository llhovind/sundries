'use strict';

const Utils   = require('../common/utils');
const Vendors = require('../models/vendors');

const VendorsCntlr = function () {

    return { find, findOne, create, update };

    // GET /api/v1/vendors
    function find(req, res, next) {
        Vendors.findAll({ search: req.query.q })
            .then(vendors => {
                res.locals.results = { vendors };
                res.locals.status  = 200;
                res.locals.message = 'Vendors returned';
                next();
            })
            .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
    }

    // GET /api/v1/vendors/:id
    function findOne(req, res, next) {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return next({ status: 400, message: 'Invalid vendor id' });

        Vendors.findOne(id)
            .then(v => {
                if (!v) return next({ status: 404, message: 'Vendor not found' });
                res.locals.results = { vendor: v };
                res.locals.status  = 200;
                res.locals.message = 'Vendor returned';
                next();
            })
            .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
    }

    // POST /api/v1/vendors
    function create(req, res, next) {
        try {
            Vendors.create(req.body, req.user.id)
                .then(v => {
                    res.locals.results = { vendor: v };
                    res.locals.status  = 201;
                    res.locals.message = 'Vendor created';
                    next();
                })
                .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
        } catch (err) {
            next({ status: 400, message: err.message });
        }
    }

    // PUT /api/v1/vendors/:id
    function update(req, res, next) {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return next({ status: 400, message: 'Invalid vendor id' });

        Vendors.update(id, req.body, req.user.id)
            .then(v => {
                if (!v) return next({ status: 404, message: 'Vendor not found' });
                res.locals.results = { vendor: v };
                res.locals.status  = 200;
                res.locals.message = 'Vendor updated';
                next();
            })
            .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
    }

};

module.exports = VendorsCntlr;
