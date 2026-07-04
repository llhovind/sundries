'use strict';

const Utils      = require('../common/utils');
const Pagination = require('../common/pagination');
const Customers  = require('../models/customers');

const CustomersCntlr = function () {

    return { find, findOne, getMe, create, update, upsertMe };

    // GET /api/v1/customers
    function find(req, res, next) {
        const { page, pageSize, offset } = Pagination.parsePageQuery(req.query);

        Customers.findAll({ search: req.query.q, limit: pageSize, offset })
            .then(({ rows, total }) => {
                res.locals.results = Pagination.pageResult('customers', rows, total, page, pageSize);
                res.locals.status  = 200;
                res.locals.message = 'Customers returned';
                next();
            })
            .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
    }

    // GET /api/v1/customers/me
    function getMe(req, res, next) {
        Customers.findByUserId(req.user.id)
            .then(customer => {
                res.locals.results = { customer: customer || null };
                res.locals.status  = 200;
                res.locals.message = customer ? 'Profile returned' : 'No profile found';
                next();
            })
            .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
    }

    // PUT /api/v1/customers/me
    function upsertMe(req, res, next) {
        try {
            Customers.upsertForUser(req.user.id, req.body)
                .then(customer => {
                    res.locals.results = { customer };
                    res.locals.status  = 200;
                    res.locals.message = 'Profile saved';
                    next();
                })
                .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
        } catch (err) {
            next({ status: 400, message: err.message });
        }
    }

    // GET /api/v1/customers/:id
    function findOne(req, res, next) {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return next({ status: 400, message: 'Invalid customer id' });

        Customers.findOne(id)
            .then(c => {
                if (!c) return next({ status: 404, message: 'Customer not found' });
                res.locals.results = { customer: c };
                res.locals.status  = 200;
                res.locals.message = 'Customer returned';
                next();
            })
            .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
    }

    // POST /api/v1/customers
    function create(req, res, next) {
        try {
            Customers.create(req.body, req.user.id)
                .then(c => {
                    res.locals.results = { customer: c };
                    res.locals.status  = 201;
                    res.locals.message = 'Customer created';
                    next();
                })
                .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
        } catch (err) {
            next({ status: 400, message: err.message });
        }
    }

    // PUT /api/v1/customers/:id
    function update(req, res, next) {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return next({ status: 400, message: 'Invalid customer id' });

        Customers.update(id, req.body, req.user.id)
            .then(c => {
                if (!c) return next({ status: 404, message: 'Customer not found' });
                res.locals.results = { customer: c };
                res.locals.status  = 200;
                res.locals.message = 'Customer updated';
                next();
            })
            .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
    }

};

module.exports = CustomersCntlr;
