const jwt = require('jsonwebtoken');

function auth(req, res, next) {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Missing or invalid authorization header' });
    }

    const token = header.slice(7);
    try {
        const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
        req.user = {
            id:    payload.sub,
            email: payload.email,
            role:  payload.role,                                    // legacy primary role
            roles: Array.isArray(payload.roles) ? payload.roles : undefined,
            perms: Array.isArray(payload.perms) ? payload.perms : undefined,
        };
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Token invalid or expired' });
    }
}

module.exports = auth;
