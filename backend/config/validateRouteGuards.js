'use strict';

const { ROUTE_PERMS, UNGUARDED_ROUTES } = require('./routePermissions');

/**
 * Startup validation that the mounted Express routes and
 * config/routePermissions.js agree exactly:
 *
 *  - every guarded /api/v1 route matches its config entry code-for-code
 *  - every unguarded /api/v1 route is explicitly allow-listed
 *  - every config/allowlist entry corresponds to a real route
 *
 * Any drift throws, crashing the process at boot — a misrouted permission
 * must never make it to serving traffic. validatePermissionCodes() addition-
 * ally verifies (async, needs the DB) that every referenced permission code
 * exists in the permissions table.
 */

const API_PREFIX = '/api/v1';

/** Recover the mount path of a sub-router layer from its path regexp. */
function mountPath(layer) {
    if (layer.regexp && layer.regexp.fast_slash) return '';
    return layer.regexp.source
        .replace(/^\^/, '')
        .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
        .replace(/\$\/?$/, '')
        .replace(/\\\//g, '/');
}

/**
 * Walks the app's router tree and returns a Map of
 * 'METHOD /full/path' → [permission codes collected from requirePermission
 * middlewares], both router-level (router.use) and route-level.
 */
function collectApiRoutes(app) {
    const routes = new Map();
    if (!app._router) return routes;   // Express 4 creates the router lazily

    (function walk(stack, prefix, inheritedCodes) {
        const active = [...inheritedCodes];
        for (const layer of stack) {
            if (layer.route) {
                const routeCodes = layer.route.stack
                    .filter(l => l.handle.permissionCodes)
                    .flatMap(l => l.handle.permissionCodes);
                for (const method of Object.keys(layer.route.methods)) {
                    const verb = method === '_all' ? 'ALL' : method.toUpperCase();
                    const path = prefix + (layer.route.path === '/' ? '' : layer.route.path);
                    routes.set(`${verb} ${path}`, [...active, ...routeCodes]);
                }
            } else if (layer.name === 'router' && layer.handle.stack) {
                walk(layer.handle.stack, prefix + mountPath(layer), active);
            } else if (layer.handle.permissionCodes) {
                // router.use(requirePermission(...)) — applies to the rest of
                // this router's stack
                active.push(...layer.handle.permissionCodes);
            }
        }
    })(app._router.stack, '', []);
    return routes;
}

function sameCodes(a, b) {
    return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/**
 * @param {import('express').Express} app
 * @param {object} [overrides] - test seam: { routePerms, unguarded }
 * @throws {Error} listing every mismatch found
 */
function validateRouteGuards(app, { routePerms = ROUTE_PERMS, unguarded = UNGUARDED_ROUTES } = {}) {
    const problems = [];
    const actual   = collectApiRoutes(app);
    const unguardedSet = new Set(unguarded);

    for (const key of Object.keys(routePerms)) {
        if (unguardedSet.has(key)) problems.push(`listed as both guarded and unguarded: ${key}`);
    }

    for (const [key, codes] of actual) {
        if (!key.includes(` ${API_PREFIX}/`)) continue;   // only the versioned API is governed

        const expected = routePerms[key];
        if (codes.length > 0) {
            if (!expected) {
                problems.push(`guarded route missing from ROUTE_PERMS: ${key} [${codes.join(', ')}]`);
            } else if (!sameCodes(expected, codes)) {
                problems.push(
                    `permission mismatch on ${key}: config [${expected.join(', ')}] vs route [${codes.join(', ')}]`);
            }
        } else if (expected) {
            problems.push(`ROUTE_PERMS expects [${expected.join(', ')}] on ${key} but the route has no guard`);
        } else if (!unguardedSet.has(key)) {
            problems.push(`unguarded API route is not allow-listed: ${key}`);
        }
    }

    for (const key of Object.keys(routePerms)) {
        if (!actual.has(key)) problems.push(`ROUTE_PERMS entry has no matching route: ${key}`);
    }
    for (const key of unguarded) {
        if (!actual.has(key)) problems.push(`UNGUARDED_ROUTES entry has no matching route: ${key}`);
    }

    if (problems.length) {
        throw new Error(
            `Route permission validation failed (${problems.length}):\n  - ${problems.join('\n  - ')}`);
    }
}

/**
 * Verifies every permission code referenced by ROUTE_PERMS exists in the
 * permissions table. Async (DB) — called from bin/www at boot and from tests.
 */
async function validatePermissionCodes(db = require('../common/db').DB) {
    const referenced = [...new Set(Object.values(ROUTE_PERMS).flat())];
    const res   = await db.query('SELECT code FROM permissions WHERE code = ANY($1)', [referenced]);
    const known = new Set(res.rows.map(r => r.code));
    const missing = referenced.filter(c => !known.has(c));
    if (missing.length) {
        throw new Error(`ROUTE_PERMS references unknown permission codes: ${missing.join(', ')}`);
    }
}

module.exports = { collectApiRoutes, validateRouteGuards, validatePermissionCodes };
