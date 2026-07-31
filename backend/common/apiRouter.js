'use strict';

const express = require('express');
const { sharedRegistry } = require('../config/routeRegistry');

/**
 * Express adapter for the route registry (config/routeRegistry.js).
 *
 * createApiRouter() returns an ordinary express.Router() whose registration
 * methods additionally declare each endpoint — method, full path, and the
 * permission codes on its handler chain — into the registry. Route files are
 * otherwise unchanged: they still call router.get('/:id', guard(...), handler).
 *
 * The router owns its own base path, and mountApi() mounts it at that path, so
 * the full path a route declares is the full path it actually serves. There is
 * no second place to keep in sync.
 *
 * Usage:
 *   // routes/products.js
 *   const router = createApiRouter('/api/v1/products');
 *   router.post('/', guard('POST /api/v1/products'), ProductsCntlr.create);
 *
 *   // app.js
 *   mountApi(app, optionalAuth, require('./routes/products'));
 */

const API_PREFIX = '/api/v1';

/** Registration methods that define an endpoint. */
const ROUTE_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'];

/**
 * @param {string} basePath - absolute mount path, e.g. '/api/v1/products'
 * @param {object} [deps] - test seam: { registry }
 * @returns {import('express').Router & { basePath: string }}
 */
function createApiRouter(basePath, { registry = sharedRegistry } = {}) {
    assertBasePath(basePath);

    const router = express.Router();
    // Codes from router.use(guard(...)) — they apply to every route registered
    // after that call on this router, mirroring Express's own middleware order.
    const inheritedCodes = [];

    // router.get/post/put/... all funnel through router.route(path) inside
    // Express, so wrapping it is the one interception point that covers every
    // registration style — including a direct router.route(path).get(...).
    const createRoute = router.route.bind(router);
    router.route = (path) => {
        const route = createRoute(path);
        for (const method of ROUTE_METHODS) {
            const addHandlers = route[method].bind(route);
            route[method] = (...handlers) => {
                const flat = handlers.flat();
                const key = endpointKey(method, basePath, path);
                assertGuardKeys(flat, key);
                registry.declare(key, [...inheritedCodes, ...permissionCodesOf(flat)]);
                return addHandlers(...handlers);
            };
        }
        return route;
    };

    const use = router.use.bind(router);
    router.use = (...args) => {
        const [first] = args;

        // router.use(childApiRouter) — nested API surface. The child knows its
        // own absolute base path, so the relative mount point is derived rather
        // than restated, and a child mounted under the wrong parent throws.
        if (args.length === 1 && isApiRouter(first)) {
            return use(relativeMount(basePath, first.basePath), first);
        }
        // router.use(guard(...)) — applies to the rest of this router's routes.
        if (typeof first === 'function' && Array.isArray(first.permissionCodes)) {
            inheritedCodes.push(...first.permissionCodes);
        }
        return use(...args);
    };

    router.basePath = basePath;
    return router;
}

/**
 * Mounts an API router at its own declared base path.
 *
 * @param {import('express').Express} app
 * @param {...(import('express').RequestHandler | import('express').Router)} args
 *   any middleware to run before the router, then the router itself
 */
function mountApi(app, ...args) {
    const router = args.pop();
    if (!isApiRouter(router)) {
        throw new Error('mountApi() requires a router created by createApiRouter()');
    }
    return app.use(router.basePath, ...args, router);
}

function isApiRouter(value) {
    return typeof value === 'function' && typeof value.basePath === 'string';
}

function assertBasePath(basePath) {
    if (typeof basePath !== 'string' || !basePath.startsWith(`${API_PREFIX}/`)) {
        throw new Error(`API router base path must start with "${API_PREFIX}/": ${basePath}`);
    }
    if (basePath.endsWith('/')) {
        throw new Error(`API router base path must not end with "/": ${basePath}`);
    }
}

/** 'POST' + '/api/v1/products' + '/:id' → 'POST /api/v1/products/:id' */
function endpointKey(method, basePath, path) {
    if (typeof path !== 'string') {
        throw new Error(
            `Route path must be a string so the endpoint can be declared (${basePath}, ${method})`);
    }
    const verb = method.toUpperCase();
    return `${verb} ${basePath}${path === '/' ? '' : path}`;
}

function permissionCodesOf(handlers) {
    return handlers.flatMap(h => (Array.isArray(h.permissionCodes) ? h.permissionCodes : []));
}

/**
 * A guard built from config/routePermissions.js carries the endpoint key it was
 * looked up under. If that disagrees with where the route is actually
 * registered, the route is running some other endpoint's permissions.
 */
function assertGuardKeys(handlers, key) {
    for (const handler of handlers) {
        if (handler.endpointKey && handler.endpointKey !== key) {
            throw new Error(
                `Guard declares "${handler.endpointKey}" but the route is registered as "${key}"`);
        }
    }
}

/** '/api/v1/inventory' + '/api/v1/inventory/transfers' → '/transfers' */
function relativeMount(parentBase, childBase) {
    if (!childBase.startsWith(`${parentBase}/`)) {
        throw new Error(
            `Nested router "${childBase}" is not under its parent "${parentBase}"`);
    }
    return childBase.slice(parentBase.length);
}

module.exports = { createApiRouter, mountApi, API_PREFIX };
