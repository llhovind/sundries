'use strict';

const requirePermission = require('./requirePermission');
const registry = require('../services/reporting/registry');
const { ALL_CATEGORY_PERMISSIONS } = require('../services/reporting/categories');

/**
 * Category-scoped guard for /reports/:slug routes.
 *
 * Which permission applies depends on the report addressed, so it cannot be
 * fixed at route-registration time like other endpoints: the guard resolves
 * :slug through the report registry at request time and enforces that
 * report's category permission via the standard requirePermission check.
 *
 * For the startup route-guard validation this middleware declares the full
 * category permission set (`permissionCodes`) — the widest access any slug
 * can grant; runtime enforcement is always narrower (exactly one category).
 * config/routePermissions.js lists the same set, so drift still fails boot.
 *
 * Unknown slugs 404 for any authenticated staff caller — report names are
 * not secrets (they ship in this repo), and a correct 404 beats a misleading
 * 403 when a report file has been removed.
 */
function requireReportAccess() {
    guard.permissionCodes = [...ALL_CATEGORY_PERMISSIONS];
    return guard;

    function guard(req, res, next) {
        const def = registry.get(req.params.slug);
        if (!def) {
            return next({ status: 404, message: `Unknown report: ${req.params.slug}` });
        }
        res.locals.reportDef = def;
        return requirePermission(registry.permissionFor(def))(req, res, next);
    }
}

module.exports = requireReportAccess;
