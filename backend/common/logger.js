'use strict';

/**
 * Structured JSON logger — the single logging adapter for the backend.
 *
 * Every runtime log line is one JSON object per line on stdout:
 *
 *   { "level": "...", "msg": "...", "ts": "<ISO-8601>", ...context }
 *
 * This is the one place that knows how a log line is formatted; everything
 * else (services, routes, controllers, bin scripts) imports `log` from here.
 * Do not write to stdout/stderr or call console.* for logging anywhere else.
 *
 * Rules:
 *   - Never log PII (emails, names, addresses) or live credentials (OTPs,
 *     tokens, invitation codes). Log numeric IDs instead.
 *   - Pass Error instances directly in the context (e.g. { error: err });
 *     they are serialized to { name, message, code?, status?, stack } —
 *     a raw Error passed through JSON.stringify serializes to "{}".
 *
 * Note: process.stdout.write is resolved at call time on purpose, so test
 * harnesses that swap the stream (see tests/reports.test.js) capture output.
 */

const requestContext = require('./requestContext');

const LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

function serializeValue(value) {
    if (value instanceof Error) {
        const out = { name: value.name, message: value.message };
        if (value.code   !== undefined) out.code   = value.code;
        if (value.status !== undefined) out.status = value.status;
        if (value.stack) out.stack = value.stack;
        return out;
    }
    if (Array.isArray(value)) {
        return value.map(serializeValue);
    }
    return value;
}

/**
 * Render one log entry to its JSON line (no trailing newline). Exposed so
 * adapters with their own write path (e.g. morgan's access log in app.js)
 * emit the exact same envelope.
 *
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} msg     - stable, lowercase event description
 * @param {object} [extra] - structured context (IDs, counts, Error instances)
 * @returns {string}
 */
function format(level, msg, extra = {}) {
    const entry = { level, msg, ts: new Date().toISOString() };
    const ctx = requestContext.get();
    if (ctx?.correlationId) entry.correlationId = ctx.correlationId;
    if (ctx?.ip) entry.ip = ctx.ip;
    for (const [key, value] of Object.entries(extra)) {
        entry[key] = serializeValue(value);
    }
    return JSON.stringify(entry);
}

/**
 * Emit one structured log line to stdout.
 * Same signature as format().
 */
function log(level, msg, extra = {}) {
    process.stdout.write(format(level, msg, extra) + '\n');
}

module.exports = {
    log,
    format,
    LEVELS,
    debug: (msg, extra) => log('debug', msg, extra),
    info:  (msg, extra) => log('info',  msg, extra),
    warn:  (msg, extra) => log('warn',  msg, extra),
    error: (msg, extra) => log('error', msg, extra),
};
