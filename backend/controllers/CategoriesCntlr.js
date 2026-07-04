'use strict';

const Utils      = require('../common/utils');
const Pagination = require('../common/pagination');
const Categories = require('../models/categories');

const CategoriesCntlr = function () {

    return { find, findOne, create, update, remove };

    // GET /api/v1/categories
    function find(req, res, next) {
        const { page, pageSize, offset } = Pagination.parsePageQuery(req.query, {
            defaultPageSize: 100,
            maxPageSize: 200,
        });

        Categories.findAll({ search: req.query.q, limit: pageSize, offset })
            .then(({ rows, total }) => {
                res.locals.results = Pagination.pageResult('categories', rows, total, page, pageSize);
                res.locals.status  = 200;
                res.locals.message = 'Categories returned';
                next();
            })
            .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
    }

    // GET /api/v1/categories/:id
    function findOne(req, res, next) {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return next({ status: 400, message: 'Invalid category id' });

        Categories.findOne(id)
            .then(cat => {
                if (!cat) return next({ status: 404, message: 'Category not found' });
                res.locals.results = { category: cat };
                res.locals.status  = 200;
                res.locals.message = 'Category returned';
                next();
            })
            .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
    }

    // POST /api/v1/categories
    function create(req, res, next) {
        const { name } = req.body;
        if (!name || !name.trim()) return next({ status: 400, message: 'name is required' });

        Categories.create(name.trim(), req.user.id)
            .then(cat => {
                res.locals.results = { category: cat };
                res.locals.status  = 201;
                res.locals.message = 'Category created';
                next();
            })
            .catch(err => {
                const status = err.code === '23505' ? 409 : 500;
                const message = status === 409 ? 'Category name already exists' : Utils.evaluateError(err).message;
                next({ status, message });
            });
    }

    // PUT /api/v1/categories/:id
    function update(req, res, next) {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return next({ status: 400, message: 'Invalid category id' });

        const { name } = req.body;
        if (!name || !name.trim()) return next({ status: 400, message: 'name is required' });

        Categories.update(id, name.trim(), req.user.id)
            .then(cat => {
                if (!cat) return next({ status: 404, message: 'Category not found' });
                res.locals.results = { category: cat };
                res.locals.status  = 200;
                res.locals.message = 'Category updated';
                next();
            })
            .catch(err => {
                const status = err.code === '23505' ? 409 : 500;
                const message = status === 409 ? 'Category name already exists' : Utils.evaluateError(err).message;
                next({ status, message });
            });
    }

    // DELETE /api/v1/categories/:id
    function remove(req, res, next) {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return next({ status: 400, message: 'Invalid category id' });

        Categories.remove(id)
            .then(removed => {
                if (!removed) return next({ status: 404, message: 'Category not found' });
                res.locals.results = { id: removed.id };
                res.locals.status  = 200;
                res.locals.message = 'Category deleted';
                next();
            })
            .catch(err => {
                const status = err.code === '23503' ? 409 : 500;
                const message = status === 409 ? 'Category is still assigned to items' : Utils.evaluateError(err).message;
                next({ status, message });
            });
    }

};

module.exports = CategoriesCntlr;
