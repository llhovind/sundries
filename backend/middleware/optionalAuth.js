'use strict';

const { decodeUser } = require('./auth');

/**
 * Auth for mixed public/protected routers (storefront catalog): identifies
 * the caller when a token is presented, but lets anonymous requests through
 * with req.user unset.
 *
 * A present-but-invalid token is still a 401 — treating it as anonymous
 * would silently downgrade logged-in shoppers whose access token expired,
 * bypassing the client's refresh flow. Per-route write protection stays
 * with requirePermission, which rejects anonymous callers.
 */
function optionalAuth(req, res, next) {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
        return next();   // anonymous shopper
    }

    try {
        req.user = decodeUser(header.slice(7));
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Token invalid or expired' });
    }
}

module.exports = optionalAuth;
