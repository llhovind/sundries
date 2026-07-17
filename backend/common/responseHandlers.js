'use strict';

const { log } = require('./logger');

var responseHandlers = (function () {

    return {
        handleResponse: handleResponse,
        handleErrorResponse: handleErrorResponse
    };

    function buildResponseEnvelope(res, req) {
        var response = {
            path: req.method + " " + req.path,
            outcome: {}
        };

        if (req && req.query && Object.keys(req.query).length) {
            response.queryParams = {};
            Object.keys(req.query).forEach(key => {
                response.queryParams[key] = req.query[key];
            })
        }

        response.outcome.statusCode = res.locals.status;
        
        if (res.locals.message) {
            response.outcome.message = res.locals.message;
        }

        if (res.locals.errors && res.locals.errors.length > 0) {
            response.outcome.errors = res.locals.errors;
        }
        if (res.locals.warnings && res.locals.warnings.length > 0) {
            response.outcome.warnings = res.locals.warnings;
        }
        // Structured per-line detail (e.g. checkout reservation failures) —
        // machine-readable, unlike the human-oriented errors array.
        if (res.locals.failures) {
            response.outcome.failures = res.locals.failures;
        }
        if (res.locals.info && res.locals.info.length > 0) {
            response.outcome.info = res.locals.info;
        }

        if (res.locals.results) {

            response.content = res.locals.results;
        }

        return response;
    }

    function handleResponse(req, res, next) {

        // set response status
        res.status(res.locals.status || 404);

        // handle redirect
        if (res.locals.redirect_url) {

            res.redirect(res.locals.status, res.locals.redirect_url);

        } else {
            if (res.locals.status) {
                res.json(buildResponseEnvelope(res, req));
            } else {
                res.json({ path: req.method + " " + req.path, message: '404 - Not Found' });
            }
        }
    }

    function handleErrorResponse(err, req, res, next) {
        log('error', 'request failed', {
            method: req.method,
            path: req.path,
            status: res.locals.status || err.status || 500,
            error: err,
            errors: res.locals.errors,
            warnings: res.locals.warnings,
        });

        // set status
        res.locals.status = res.locals.status || err.status || 500;
        res.status(res.locals.status);

        res.locals.message = res.locals.message || err.message || 'Express.App catching: Internal Server error';

        res.locals.errors = res.locals.errors || [];
        res.locals.errors.push(err);
        if (err && err.failures) {
            res.locals.failures = res.locals.failures || err.failures;
        }

        // build envelope
        res.json(buildResponseEnvelope(res, req));
    }

}());

module.exports = responseHandlers;