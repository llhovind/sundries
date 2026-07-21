'use strict';

/**
 * Unit tests for the structured logger's request-context enrichment.
 *
 * The client ip is captured once by requestContext.middleware and must appear
 * on every rendered log line — both direct log.*() calls and the morgan
 * 'http access' line, which share this same format() path. A regression here
 * silently drops ip from the entire log stream (it only survives in the DB
 * audit_log), so it is asserted directly.
 */

const Logger = require('../common/logger');
const requestContext = require('../common/requestContext');

/** Drive a fake request through the real context middleware, then run fn inside it. */
function withRequest({ ip, headers = {} }, fn) {
    const req = { ip, headers };
    const res = { set() {} };
    let result;
    requestContext.middleware(req, res, () => { result = fn(); });
    return result;
}

describe('common/logger request-context enrichment', () => {

    test('given a request context when formatting then the line carries ip and correlationId', () => {
        const line = withRequest({ ip: '203.0.113.7' }, () => Logger.format('info', 'http access'));
        const entry = JSON.parse(line);
        expect(entry.ip).toBe('203.0.113.7');
        expect(entry.correlationId).toBeTruthy();
    });

    test('given an incoming X-Request-Id then it is honored as the correlationId', () => {
        const line = withRequest(
            { ip: '203.0.113.7', headers: { 'x-request-id': 'gateway-abc-123' } },
            () => Logger.format('info', 'event'),
        );
        expect(JSON.parse(line).correlationId).toBe('gateway-abc-123');
    });

    test('given a request with no resolvable ip then the ip field is omitted, not null', () => {
        const line = withRequest({ ip: undefined }, () => Logger.format('info', 'event'));
        expect(JSON.parse(line)).not.toHaveProperty('ip');
    });

    test('given no request context (job/CLI) then neither ip nor correlationId appear', () => {
        const entry = JSON.parse(Logger.format('info', 'batch job done', { count: 3 }));
        expect(entry).not.toHaveProperty('ip');
        expect(entry).not.toHaveProperty('correlationId');
        expect(entry.count).toBe(3);
    });
});
