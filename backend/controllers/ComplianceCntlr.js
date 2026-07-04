'use strict';

const ComplianceService = require('../services/complianceService');
const Rbac              = require('../models/rbac');
const Pagination        = require('../common/pagination');

const ComplianceCntlr = function () {

    return { createRequest, list };

    // POST /api/v1/compliance/requests
    // Customers file for their own email; staff (customers:write) for anyone.
    async function createRequest(req, res, next) {
        try {
            const { req_type, email } = req.body || {};
            if (!Array.isArray(req.user.perms)) {
                req.user.perms = await Rbac.getPermissionsForUser(req.user.id);
            }
            const staff = req.user.perms.includes('customers:write');
            const subjectEmail = staff && email ? email : req.user.email;

            const request = await ComplianceService.createRequest({ req_type, email: subjectEmail });

            const Jobs = require('../services/jobs');
            Jobs.send(Jobs.QUEUES.COMPLIANCE, { id: request.id }).catch(() => {});

            res.locals.results = { request };
            res.locals.status  = 201;
            res.locals.message = 'Compliance request filed';
            next();
        } catch (err) {
            next({ status: err.status || 500, message: err.message });
        }
    }

    // GET /api/v1/compliance/requests — staff view (customers:write)
    function list(req, res, next) {
        const { page, pageSize, offset } = Pagination.parsePageQuery(req.query);
        ComplianceService.list({ status: req.query.status || null, limit: pageSize, offset })
            .then(({ rows, total }) => {
                res.locals.results = Pagination.pageResult('requests', rows, total, page, pageSize);
                res.locals.status  = 200;
                res.locals.message = 'Compliance requests returned';
                next();
            })
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

};

module.exports = ComplianceCntlr;
