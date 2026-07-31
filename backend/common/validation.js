'use strict';

/**
 * Field validators shared by the admin-configuration models and by any route
 * that has to vet request input before it reaches a service.
 *
 * Most validators return the normalized value or throw an Error tagged with
 * `status: 400` naming the offending field, so controllers can pass the
 * message straight to the client. Predicates (`isValidEmail`) return a boolean
 * instead, for call sites that own their own error channel.
 */

// RFC 5321 §4.5.3.1.3 caps a forward-path at 254 characters. Nothing longer is
// a deliverable address, so rejecting on length costs nothing — and it is what
// keeps EMAIL_PATTERN cheap. Both of the pattern's trailing character classes
// admit '.', so on a long non-matching input the engine explores every split
// point for the literal dot: cost grows with the square of the input, and a
// 100kb request body (express.json()'s default ceiling) blocks the event loop
// for seconds. Bounded at 254 the worst case is microseconds.
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function badRequest(message) {
    return Object.assign(new Error(message), { status: 400 });
}

/**
 * Shape check for an email address — presence of a local part, an '@', and a
 * dotted domain. Deliberately not a full RFC 5322 grammar: delivery is the
 * only real proof an address exists, and this codebase already gates
 * registration and login on a mailed OTP.
 *
 * Returns a boolean rather than throwing because the call sites report failure
 * through different channels (`res.status(400).json(...)` in routes, `next(err)`
 * in controllers) and each owns its own message.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidEmail(value) {
    return typeof value === 'string'
        && value.length <= MAX_EMAIL_LENGTH
        && EMAIL_PATTERN.test(value);
}

/** Non-empty trimmed string. */
function requireString(value, field, { pattern, patternHint } = {}) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw badRequest(`${field} is required`);
    }
    const normalized = value.trim();
    if (pattern && !pattern.test(normalized)) {
        throw badRequest(`${field} ${patternHint || `must match ${pattern}`}`);
    }
    return normalized;
}

/** Optional string; empty/null/undefined normalize to null. */
function optionalString(value, field) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
    return value.trim() || null;
}

/** Finite number within [min, max]; integers enforced when asked. */
function requireNumber(value, field, { min, max, integer } = {}) {
    const n = Number(value);
    if (value === null || value === undefined || value === '' || !Number.isFinite(n)) {
        throw badRequest(`${field} must be a number`);
    }
    if (integer && !Number.isInteger(n))     throw badRequest(`${field} must be an integer`);
    if (min !== undefined && n < min)        throw badRequest(`${field} must be >= ${min}`);
    if (max !== undefined && n > max)        throw badRequest(`${field} must be <= ${max}`);
    return n;
}

/** Optional number; null/undefined/'' normalize to null. */
function optionalNumber(value, field, opts = {}) {
    if (value === null || value === undefined || value === '') return null;
    return requireNumber(value, field, opts);
}

/** Value must be one of the allowed set. */
function oneOf(value, field, allowed) {
    if (!allowed.includes(value)) {
        throw badRequest(`${field} must be one of: ${allowed.join(', ')}`);
    }
    return value;
}

module.exports = {
    MAX_EMAIL_LENGTH,
    badRequest,
    isValidEmail,
    requireString,
    optionalString,
    requireNumber,
    optionalNumber,
    oneOf,
};
