'use strict';

/**
 * Generic report-parameter validation.
 *
 * Report controllers declare their inputs as data (`params` on the report
 * definition); this module turns a raw query/body object into a validated,
 * normalized value bag — or throws a status-tagged 400. No report ever
 * parses its own inputs, so a malformed report can't skip validation.
 *
 * Supported param types:
 *   date    'YYYY-MM-DD'
 *   month   'YYYY-MM'
 *   number  integer (e.g. a warehouse number)
 *   select  one of the declared `options`
 *
 * `default` may be a literal or a zero-arg function (evaluated at request
 * time, so "last 30 days" style defaults stay current). A param with no
 * default and no supplied value is null unless `required`.
 */

const DATE_REGEX  = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_REGEX = /^\d{4}-\d{2}$/;

const PARAM_TYPES = Object.freeze(['date', 'month', 'number', 'select']);

function badRequest(message) {
    throw Object.assign(new Error(message), { status: 400 });
}

/** Resolve a param's default to a concrete value (or null). */
function resolveDefault(param) {
    if (param.default === undefined) return null;
    return typeof param.default === 'function' ? param.default() : param.default;
}

/** Shape AND calendar validity — '2026-13-99' matches the regex but is no date. */
function isRealDate(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

function parseValue(param, raw) {
    switch (param.type) {
        case 'date':
            if (!DATE_REGEX.test(raw) || !isRealDate(raw)) {
                badRequest(`${param.name} must be a valid YYYY-MM-DD date`);
            }
            return raw;
        case 'month':
            if (!MONTH_REGEX.test(raw) || !isRealDate(raw + '-01')) {
                badRequest(`${param.name} must be a valid YYYY-MM month`);
            }
            return raw;
        case 'number': {
            const n = parseInt(raw, 10);
            if (isNaN(n)) badRequest(`${param.name} must be a number`);
            return n;
        }
        case 'select':
            if (!param.options.includes(raw)) {
                badRequest(`${param.name} must be one of: ${param.options.join(', ')}`);
            }
            return raw;
        /* istanbul ignore next — registry validation rejects unknown types at boot */
        default:
            badRequest(`Unknown param type for ${param.name}`);
    }
}

/**
 * @param {Array} paramDefs - the report definition's `params`
 * @param {object} raw - req.query / stored run params
 * @returns {object} validated values keyed by param name
 * @throws {{status: 400}} on any invalid value
 */
function validateParams(paramDefs, raw = {}) {
    const values = {};
    for (const param of paramDefs) {
        const supplied = raw[param.name];
        if (supplied === undefined || supplied === '' || supplied === null) {
            const dflt = resolveDefault(param);
            if (dflt === null && param.required) badRequest(`${param.name} is required`);
            values[param.name] = dflt;
        } else {
            values[param.name] = parseValue(param, String(supplied));
        }
    }
    return values;
}

/**
 * Serialize param definitions for the catalog endpoint: defaults are
 * resolved to concrete values so the UI can prefill controls generically.
 */
function describeParams(paramDefs) {
    return paramDefs.map(p => ({
        name:     p.name,
        label:    p.label,
        type:     p.type,
        required: Boolean(p.required),
        options:  p.options || null,
        default:  resolveDefault(p),
    }));
}

module.exports = { PARAM_TYPES, validateParams, describeParams };
