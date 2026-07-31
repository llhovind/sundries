'use strict';

const { ROUTE_PERMS, UNGUARDED_ROUTES } = require('./routePermissions');
const { sharedRegistry } = require('./routeRegistry');

/**
 * Startup validation that the API's declared routes (config/routeRegistry.js,
 * populated as route files register themselves) and config/routePermissions.js
 * agree exactly:
 *
 *  - every guarded /api/v1 route matches its config entry code-for-code
 *  - every unguarded /api/v1 route is explicitly allow-listed
 *  - every config/allowlist entry corresponds to a real route
 *
 * Any drift throws, crashing the process at boot — a misrouted permission
 * must never make it to serving traffic. validatePermissionCodes() addition-
 * ally verifies (async, needs the DB) that every referenced permission code
 * exists in the permissions table.
 *
 * The routes reach this file through the registry rather than through Express
 * introspection; see config/routeRegistry.js for why that matters.
 */

const API_PREFIX = '/api/v1';

/**
 * The declared API surface: 'METHOD /full/path' → permission codes, both
 * router-level (router.use) and route-level.
 *
 * @param {import('./routeRegistry').RouteRegistry} [registry]
 * @returns {Map<string, string[]>}
 */
function collectApiRoutes(registry = sharedRegistry) {
    return registry.all();
}

function sameCodes(a, b) {
    return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/**
 * @param {object} [overrides] - test seam: { routePerms, unguarded, registry }
 * @throws {Error} listing every mismatch found
 */
function validateRouteGuards({
    routePerms = ROUTE_PERMS,
    unguarded  = UNGUARDED_ROUTES,
    registry   = sharedRegistry,
} = {}) {
    const problems = [];
    const actual   = collectApiRoutes(registry);
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
