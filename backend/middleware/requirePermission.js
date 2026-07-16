'use strict';

const Rbac = require('../models/rbac');

/**
 * Route guard: allows the request when the user holds ANY of the given
 * permission codes.
 *
 * Fast path: permissions are embedded in the access token at issue time
 * (req.user.perms, set by the auth middleware). Tokens minted before the
 * RBAC rollout lack the claim; those fall back to one DB lookup, cached on
 * req.user for the rest of the request.
 *
 * Usage: router.post('/', requirePermission('catalog:write'), handler)
 */
function requirePermission(...codes) {
    if (codes.length === 0) throw new Error('requirePermission needs at least one permission code');

    guard.permissionCodes = codes;   // introspection for startup route-guard validation
    return guard;

    async function guard(req, res, next) {
        if (!req.user) {
            return res.status(401).json({ message: 'Not authenticated' });
        }
        try {
            if (!Array.isArray(req.user.perms)) {
                req.user.perms = await Rbac.getPermissionsForUser(req.user.id);
            }
            if (!codes.some(c => req.user.perms.includes(c))) {
                return res.status(403).json({ message: 'Insufficient permissions' });
            }
            return next();
        } catch (err) {
            return next(err);
        }
    }
}

module.exports = requirePermission;
