'use strict';

/**
 * The API's declared security surface: an in-memory record of every
 * '<METHOD> <full path>' endpoint the application exposes, together with the
 * permission codes guarding it (empty for deliberately-unguarded endpoints).
 *
 * This is the PORT. It holds no reference to Express — routes declare
 * themselves into it as they are registered (see common/apiRouter.js, the
 * adapter), and config/validateRouteGuards.js validates it against
 * config/routePermissions.js at startup.
 *
 * Why a registry rather than walking the router tree: the mounted route table
 * is private to the web framework. Express 4 exposed it as `app._router` with
 * a `layer.regexp` per mount; Express 5 renamed the former and removed the
 * latter outright (mount paths are now opaque matcher functions resolved
 * during request dispatch, so they cannot be recovered at boot at all). A
 * security invariant must not rest on a framework's private shape — so the
 * routes declare their own identity, and the framework is left to route.
 */

/**
 * @typedef {object} RouteRegistry
 * @property {(key: string, codes: string[]) => void} declare
 * @property {() => Map<string, string[]>} all
 */

/** @returns {RouteRegistry} */
function createRouteRegistry() {
    /** @type {Map<string, string[]>} */
    const routes = new Map();

    return { declare, all };

    /**
     * Records one endpoint. Called once per route at registration time.
     *
     * @param {string} key   - '<METHOD> <full path>', e.g. 'POST /api/v1/products'
     * @param {string[]} codes - permission codes guarding it; [] when unguarded
     * @throws {Error} when the same endpoint is declared twice — two handlers
     *   on one method+path means the second is unreachable, and the guard the
     *   reader sees may not be the guard that runs.
     */
    function declare(key, codes) {
        if (routes.has(key)) {
            throw new Error(
                `Duplicate route declaration: ${key} is registered more than once`);
        }
        routes.set(key, [...codes]);
    }

    /** @returns {Map<string, string[]>} a copy — callers cannot mutate the registry */
    function all() {
        return new Map([...routes].map(([key, codes]) => [key, [...codes]]));
    }
}

/**
 * The registry the running application declares into. Route modules are
 * required once per process, so a shared instance is the natural scope;
 * tests that build throwaway apps inject their own via createRouteRegistry().
 */
const sharedRegistry = createRouteRegistry();

module.exports = { createRouteRegistry, sharedRegistry };
