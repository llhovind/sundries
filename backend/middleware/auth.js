const jwt = require('jsonwebtoken');

/**
 * Verify an access token and map its claims to the req.user shape.
 * Shared by auth (required) and optionalAuth (anonymous allowed).
 * Throws (jwt.JsonWebTokenError et al.) when the token is invalid or expired.
 */
function decodeUser(token) {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    return {
        id:    payload.sub,
        email: payload.email,
        role:  payload.role,                                    // legacy primary role
        roles: Array.isArray(payload.roles) ? payload.roles : undefined,
        perms: Array.isArray(payload.perms) ? payload.perms : undefined,
    };
}

function auth(req, res, next) {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Missing or invalid authorization header' });
    }

    try {
        req.user = decodeUser(header.slice(7));
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Token invalid or expired' });
    }
}

auth.decodeUser = decodeUser;
module.exports = auth;
