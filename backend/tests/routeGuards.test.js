'use strict';

/**
 * Route-guard coverage tests — the endpoint→permission config must match the
 * routes the application declares exactly, and every referenced permission
 * code must exist. These are the CI tripwire for a new route landing without a
 * conscious guard/allowlist decision.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const request = require('supertest');
const app     = require('../app');
const { pool } = require('../common/db');
const requirePermission = require('../middleware/requirePermission');
const { ROUTE_PERMS, UNGUARDED_ROUTES, guard } = require('../config/routePermissions');
const { createRouteRegistry } = require('../config/routeRegistry');
const { createApiRouter, mountApi } = require('../common/apiRouter');
const {
    collectApiRoutes,
    validateRouteGuards,
    validatePermissionCodes,
} = require('../config/validateRouteGuards');

afterAll(() => pool.end());

/** Declares routes on a throwaway API router with its own registry. */
function declaredBy(basePath, register) {
    const registry = createRouteRegistry();
    register(createApiRouter(basePath, { registry }));
    return registry;
}

describe('given the mounted app when route guards are validated then config and routes agree', () => {

    test('given the real app then validation passes without drift', () => {
        expect(() => validateRouteGuards()).not.toThrow();
    });

    test('given the real app then every ROUTE_PERMS endpoint exists with exactly those codes', () => {
        const actual = collectApiRoutes();
        for (const [key, codes] of Object.entries(ROUTE_PERMS)) {
            expect(actual.has(key)).toBe(true);
            expect([...actual.get(key)].sort()).toEqual([...codes].sort());
        }
    });

    test('given the real app then every UNGUARDED_ROUTES endpoint is declared with no codes', () => {
        const actual = collectApiRoutes();
        for (const key of UNGUARDED_ROUTES) {
            expect(actual.has(key)).toBe(true);
            expect(actual.get(key)).toEqual([]);
        }
    });

    test('given an unknown endpoint then guard() throws at wiring time', () => {
        expect(() => guard('GET /api/v1/not-a-real-endpoint')).toThrow(/No permission mapping/);
    });
});

describe('given drifted routes when validated then each drift class is reported', () => {

    test('given an unguarded route that is not allow-listed then validation fails', () => {
        const registry = declaredBy('/api/v1/rogue', r => r.get('/', (_req, res) => res.end()));
        expect(() => validateRouteGuards({ routePerms: {}, unguarded: [], registry }))
            .toThrow(/unguarded API route is not allow-listed: GET \/api\/v1\/rogue/);
    });

    test('given a guarded route missing from the config then validation fails', () => {
        const registry = declaredBy('/api/v1/rogue', r =>
            r.get('/', requirePermission('orders:read'), (_req, res) => res.end()));
        expect(() => validateRouteGuards({ routePerms: {}, unguarded: [], registry }))
            .toThrow(/guarded route missing from ROUTE_PERMS/);
    });

    test('given a route whose codes differ from the config then validation fails', () => {
        const registry = declaredBy('/api/v1/rogue', r =>
            r.get('/', requirePermission('orders:read'), (_req, res) => res.end()));
        expect(() => validateRouteGuards({
            routePerms: { 'GET /api/v1/rogue': ['orders:fulfill'] },
            unguarded: [],
            registry,
        })).toThrow(/permission mismatch on GET \/api\/v1\/rogue/);
    });

    test('given a config entry with no matching route then validation fails', () => {
        const registry = declaredBy('/api/v1/rogue', () => {});
        expect(() => validateRouteGuards({
            routePerms: { 'GET /api/v1/ghost': ['orders:read'] },
            unguarded: [],
            registry,
        })).toThrow(/no matching route: GET \/api\/v1\/ghost/);
    });

    test('given an allowlist entry with no matching route then validation fails', () => {
        const registry = declaredBy('/api/v1/rogue', () => {});
        expect(() => validateRouteGuards({
            routePerms: {},
            unguarded: ['GET /api/v1/ghost'],
            registry,
        })).toThrow(/UNGUARDED_ROUTES entry has no matching route/);
    });

    test('given an endpoint listed as both guarded and unguarded then validation fails', () => {
        const registry = declaredBy('/api/v1/rogue', r =>
            r.get('/', requirePermission('orders:read'), (_req, res) => res.end()));
        expect(() => validateRouteGuards({
            routePerms: { 'GET /api/v1/rogue': ['orders:read'] },
            unguarded: ['GET /api/v1/rogue'],
            registry,
        })).toThrow(/both guarded and unguarded/);
    });

    test('given a router-level guard then its codes count for every route in that router', () => {
        const registry = declaredBy('/api/v1/nested', r => {
            r.use(requirePermission('users:manage'));
            r.get('/thing', (_req, res) => res.end());
        });
        expect(() => validateRouteGuards({
            routePerms: { 'GET /api/v1/nested/thing': ['users:manage'] },
            unguarded: [],
            registry,
        })).not.toThrow();
    });

    test('given a nested API router then its routes declare their full path', () => {
        const registry = createRouteRegistry();
        const child  = createApiRouter('/api/v1/parent/child', { registry });
        child.get('/:id', requirePermission('orders:read'), (_req, res) => res.end());
        const parent = createApiRouter('/api/v1/parent', { registry });
        parent.use(child);

        expect([...registry.all().keys()]).toEqual(['GET /api/v1/parent/child/:id']);
    });
});

describe('given the route declaration adapter when misused then it fails at wiring time', () => {

    test('given a guard whose key differs from the route path then registration throws', () => {
        expect(() => declaredBy('/api/v1/products', r =>
            // guard for a different endpoint than the path it is attached to
            r.post('/', guard('POST /api/v1/categories'), (_req, res) => res.end())))
            .toThrow(/Guard declares "POST \/api\/v1\/categories" but the route is registered as "POST \/api\/v1\/products"/);
    });

    test('given the same endpoint declared twice then registration throws', () => {
        expect(() => declaredBy('/api/v1/rogue', r => {
            r.get('/thing', (_req, res) => res.end());
            r.get('/thing', (_req, res) => res.end());
        })).toThrow(/Duplicate route declaration: GET \/api\/v1\/rogue\/thing/);
    });

    test('given a base path outside the versioned API then the router is rejected', () => {
        expect(() => createApiRouter('/internal/thing', { registry: createRouteRegistry() }))
            .toThrow(/must start with "\/api\/v1\/"/);
    });

    test('given a nested router outside its parent base path then mounting throws', () => {
        const registry = createRouteRegistry();
        const parent = createApiRouter('/api/v1/parent', { registry });
        const stray  = createApiRouter('/api/v1/elsewhere', { registry });
        expect(() => parent.use(stray)).toThrow(/is not under its parent/);
    });

    test('given a plain express router then mountApi refuses to mount it', () => {
        expect(() => mountApi(express(), express.Router()))
            .toThrow(/requires a router created by createApiRouter/);
    });
});

describe('given a mounted API router then it serves the path its routes declare', () => {

    test('given a declared endpoint then it is reachable at exactly that path', async () => {
        const registry = createRouteRegistry();
        const router = createApiRouter('/api/v1/parent/child', { registry });
        router.get('/:id', (req, res) => res.json({ id: req.params.id }));

        const a = express();
        mountApi(a, router);

        const declared = [...registry.all().keys()][0];
        expect(declared).toBe('GET /api/v1/parent/child/:id');

        const res = await request(a).get('/api/v1/parent/child/42');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ id: '42' });
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
