'use strict';

/**
 * Field validators shared by the admin-configuration models.
 *
 * Each validator returns the normalized value or throws an Error tagged with
 * `status: 400` naming the offending field, so controllers can pass the
 * message straight to the client.
 */

function badRequest(message) {
    return Object.assign(new Error(message), { status: 400 });
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

module.exports = { badRequest, requireString, optionalString, requireNumber, optionalNumber, oneOf };
