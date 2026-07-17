'use strict';

const Utils      = require('../common/utils');
const Pagination = require('../common/pagination');
const AuditLog   = require('../models/auditLog');

/**
 * Read-only surface over the audit trail (audit:read). Rows are produced by
 * the DB audit triggers; this controller only filters and pages them.
 */
const AuditLogCntlr = function () {

    return { find, findEntities };

    // GET /api/v1/audit-log
    function find(req, res, next) {
        const { page, pageSize, offset } = Pagination.parsePageQuery(req.query);
        AuditLog.findAll({
            search:      req.query.q || undefined,
            entity:      req.query.entity || undefined,
            action:      req.query.action || undefined,
            actorUserId: req.query.actor || undefined,
            from:        req.query.from || undefined,
            to:          req.query.to || undefined,
            limit:       pageSize,
            offset,
        })
            .then(({ rows, total }) => {
                res.locals.results = Pagination.pageResult('entries', rows, total, page, pageSize);
                res.locals.status  = 200;
                res.locals.message = 'Audit entries returned';
                next();
            })
            .catch(err => next(err.status
                ? { status: err.status, message: err.message }
                : { status: 500, message: Utils.evaluateError(err).message }));
    }

    // GET /api/v1/audit-log/entities
    function findEntities(req, res, next) {
        AuditLog.entities()
            .then(entities => {
                res.locals.results = { entities };
                res.locals.status  = 200;
                res.locals.message = 'Audited entities returned';
                next();
            })
            .catch(err => next({ status: 500, message: Utils.evaluateError(err).message }));
    }

};

module.exports = AuditLogCntlr;
