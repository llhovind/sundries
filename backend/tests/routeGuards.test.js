'use strict';

/**
 * Route-guard coverage tests — the endpoint→permission config must match the
 * mounted router exactly, and every referenced permission code must exist.
 * These are the CI tripwire for a new route landing without a conscious
 * guard/allowlist decision.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const app     = require('../app');
const { pool } = require('../common/db');
const requirePermission = require('../middleware/requirePermission');
const { ROUTE_PERMS, UNGUARDED_ROUTES, guard } = require('../config/routePermissions');
const {
    collectApiRoutes,
    validateRouteGuards,
    validatePermissionCodes,
} = require('../config/validateRouteGuards');

afterAll(() => pool.end());

describe('given the mounted app when route guards are validated then config and router agree', () => {

    test('given the real app then validation passes without drift', () => {
        expect(() => validateRouteGuards(app)).not.toThrow();
    });

    test('given the real app then every ROUTE_PERMS endpoint exists with exactly those codes', () => {
        const actual = collectApiRoutes(app);
        for (const [key, codes] of Object.entries(ROUTE_PERMS)) {
            expect(actual.has(key)).toBe(true);
            expect([...actual.get(key)].sort()).toEqual([...codes].sort());
        }
    });

    test('given every permission code referenced by the config then it exists in the permissions table', async () => {
        await expect(validatePermissionCodes()).resolves.toBeUndefined();
    });

    test('given an unknown endpoint key then guard() throws at wiring time', () => {
        expect(() => guard('GET /api/v1/not-a-real-endpoint')).toThrow(/No permission mapping/);
    });
});

describe('given drifted apps when validated then each drift class is reported', () => {

    function appWith(register) {
        const a = express();
        register(a);
        return a;
    }

    test('given an unguarded route that is not allow-listed then validation fails', () => {
        const a = appWith(x => x.get('/api/v1/rogue', (_req, res) => res.end()));
        expect(() => validateRouteGuards(a, { routePerms: {}, unguarded: [] }))
            .toThrow(/unguarded API route is not allow-listed: GET \/api\/v1\/rogue/);
    });

    test('given a guarded route missing from the config then validation fails', () => {
        const a = appWith(x =>
            x.get('/api/v1/rogue', requirePermission('orders:read'), (_req, res) => res.end()));
        expect(() => validateRouteGuards(a, { routePerms: {}, unguarded: [] }))
            .toThrow(/guarded route missing from ROUTE_PERMS/);
    });

    test('given a route whose codes differ from the config then validation fails', () => {
        const a = appWith(x =>
            x.get('/api/v1/rogue', requirePermission('orders:read'), (_req, res) => res.end()));
        expect(() => validateRouteGuards(a, {
            routePerms: { 'GET /api/v1/rogue': ['orders:fulfill'] },
            unguarded: [],
        })).toThrow(/permission mismatch on GET \/api\/v1\/rogue/);
    });

    test('given a config entry with no matching route then validation fails', () => {
        const a = appWith(() => {});
        expect(() => validateRouteGuards(a, {
            routePerms: { 'GET /api/v1/ghost': ['orders:read'] },
            unguarded: [],
        })).toThrow(/no matching route: GET \/api\/v1\/ghost/);
    });

    test('given an allowlist entry with no matching route then validation fails', () => {
        const a = appWith(() => {});
        expect(() => validateRouteGuards(a, {
            routePerms: {},
            unguarded: ['GET /api/v1/ghost'],
        })).toThrow(/UNGUARDED_ROUTES entry has no matching route/);
    });

    test('given an endpoint listed as both guarded and unguarded then validation fails', () => {
        const a = appWith(x =>
            x.get('/api/v1/rogue', requirePermission('orders:read'), (_req, res) => res.end()));
        expect(() => validateRouteGuards(a, {
            routePerms: { 'GET /api/v1/rogue': ['orders:read'] },
            unguarded: ['GET /api/v1/rogue'],
        })).toThrow(/both guarded and unguarded/);
    });

    test('given a router-level guard then its codes count for every route in that router', () => {
        const child = express.Router();
        child.use(requirePermission('users:manage'));
        child.get('/thing', (_req, res) => res.end());
        const a = appWith(x => x.use('/api/v1/nested', child));

        expect(() => validateRouteGuards(a, {
            routePerms: { 'GET /api/v1/nested/thing': ['users:manage'] },
            unguarded: [],
        })).not.toThrow();
    });
});

describe('given the allowlist when reviewed then it stays intentionally small', () => {

    test('given UNGUARDED_ROUTES then no staff/admin surface is listed', () => {
        // These prefixes must never appear unguarded — they are staff surfaces.
        const staffPrefixes = ['/api/v1/users', '/api/v1/roles', '/api/v1/reports', '/api/v1/inventory'];
        const offenders = UNGUARDED_ROUTES.filter(key =>
            staffPrefixes.some(p => key.split(' ')[1].startsWith(p)));
        expect(offenders).toEqual([]);
    });
});
