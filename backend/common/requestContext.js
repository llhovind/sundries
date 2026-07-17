'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');

/**
 * Per-request context propagated through async call chains (AsyncLocalStorage),
 * so cross-cutting metadata reaches the logger and the DB audit helper without
 * threading extra parameters through every service/model signature.
 *
 * Holds:
 *   correlationId - honored from an incoming X-Request-Id header (so gateway
 *                   ids survive), otherwise a fresh UUID; echoed back on the
 *                   response so clients and support can quote it.
 *   ip            - client address as Express resolved it (req.ip — respects
 *                   trust proxy when configured).
 *
 * Outside a request (jobs, CLI, tests calling services directly) get() returns
 * undefined and every consumer must treat the fields as optional.
 */
const als = new AsyncLocalStorage();

// Correlation ids are quoted in logs and stored in audit rows — cap and
// whitelist so a hostile header cannot inject log content or oversized rows.
const CORRELATION_ID_MAX_LENGTH = 64;
const CORRELATION_ID_REGEX = /^[A-Za-z0-9._-]+$/;

function sanitizeIncomingId(header) {
    if (typeof header !== 'string') return null;
    const value = header.trim();
    if (!value || value.length > CORRELATION_ID_MAX_LENGTH) return null;
    return CORRELATION_ID_REGEX.test(value) ? value : null;
}

/** Express middleware — must be mounted before anything that logs or writes. */
function middleware(req, res, next) {
    const correlationId = sanitizeIncomingId(req.headers['x-request-id']) || crypto.randomUUID();
    res.set('X-Request-Id', correlationId);
    als.run({ correlationId, ip: req.ip || null }, next);
}

/** @returns {{correlationId: string, ip: string|null}|undefined} */
function get() {
    return als.getStore();
}

module.exports = { middleware, get };
