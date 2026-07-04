'use strict';

const config = require('../common/config');
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');

const { withTransaction } = require('../common/db');

const Users           = require('../models/users');
const Rbac            = require('../models/rbac');
const Customers       = require('../models/customers');
const RefreshTokens   = require('../models/refreshTokens');
const OtpCodes        = require('../models/otpCodes');
const InvitationCodes = require('../models/invitationCodes');
const mailer          = require('../common/mailer');

// ---------------------------------------------------------------------------
// Sentinel error — thrown inside a transaction to trigger rollback when an
// invitation code is exhausted by a concurrent request.
// ---------------------------------------------------------------------------
class InvitationExhaustedError extends Error {
    constructor() { super('Invitation code exhausted'); }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'ff_refresh';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const cookieOpts = {
    httpOnly: true,
    secure:   config.cookie.secure,
    sameSite: 'strict',
    path:     '/api/v1/auth',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mint an access token with the user's roles and permission codes embedded,
 * so requirePermission() never needs a DB round-trip on the hot path.
 * Grants take effect on the next token refresh (≤ JWT_ACCESS_EXPIRES).
 */
async function makeAccessToken(user) {
    const [roles, perms] = await Promise.all([
        Rbac.getRolesForUser(user.id),
        Rbac.getPermissionsForUser(user.id),
    ]);
    return jwt.sign(
        { sub: user.id, email: user.email, role: user.role, roles, perms },
        config.jwt.accessSecret,
        { expiresIn: config.jwt.accessExpires }
    );
}

function makeRefreshToken() {
    return crypto.randomBytes(40).toString('hex');
}

function refreshExpiresAt() {
    const d = new Date();
    d.setDate(d.getDate() + config.jwt.refreshExpiresDays);
    return d;
}

/**
 * Generate a 6-digit OTP and its SHA-256 hash.
 * @returns {{ otp: string, otpHash: string }}
 */
function generateOtp() {
    const otp     = crypto.randomInt(100000, 1000000).toString();
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
    return { otp, otpHash };
}

/**
 * Issue refresh + access tokens and set the httpOnly cookie.
 * @returns {Promise<{ accessToken: string }>}
 */
async function issueSession(res, user) {
    const accessToken  = await makeAccessToken(user);
    const refreshToken = makeRefreshToken();
    const expiresAt    = refreshExpiresAt();

    await RefreshTokens.create(user.id, refreshToken, expiresAt);
    res.cookie(COOKIE_NAME, refreshToken, { ...cookieOpts, expires: expiresAt });

    return { accessToken };
}

// ---------------------------------------------------------------------------
// POST /api/v1/auth/register  — customer self-registration
//
// Body: { email, invitationCode }
// 1. Validate inputs
// 2. Verify invitation code (exists, unused, not expired)
// 3. Create customer user
// 4. Consume invitation code
// 5. Issue and email OTP (registration completes on verify-otp)
// ---------------------------------------------------------------------------
router.post('/register', async (req, res) => {
    const { email, invitationCode } = req.body;

    if (!email || !invitationCode) {
        return res.status(400).json({ message: 'email and invitationCode are required' });
    }
    if (!EMAIL_REGEX.test(email)) {
        return res.status(400).json({ message: 'Invalid email address' });
    }

    try {
        const existing = await Users.findByEmail(email);
        if (existing) {
            return res.status(409).json({ message: 'Email already registered' });
        }

        const code = await InvitationCodes.findByCode(invitationCode);
        if (!code) {
            return res.status(400).json({ message: 'Invalid invitation code' });
        }
        if (code.expires_at !== null && new Date(code.expires_at) < new Date()) {
            return res.status(410).json({ message: 'Invitation code has expired' });
        }
        if (code.max_uses !== null && code.use_count >= code.max_uses) {
            return res.status(410).json({ message: 'Invitation code has reached its use limit' });
        }

        let user;
        await withTransaction(async (client) => {
            const createRes = await client.query(
                `INSERT INTO users (username, email, role, status, _create_ts, _modify_ts)
                 VALUES (NULL, $1, 'customer', 'active', NOW(), NOW())
                 RETURNING id, username, email, role, status`,
                [email]
            );
            user = createRes.rows[0];

            // user_roles is the RBAC source of truth; the users.role column is
            // legacy-compat until the transition completes.
            await client.query(
                `INSERT INTO user_roles (user_id, role_no)
                 SELECT $1, role_no FROM roles WHERE code = 'customer'`,
                [user.id]
            );

            const updateRes = await client.query(
                `UPDATE invitation_codes
                 SET use_count = use_count + 1
                 WHERE id = $1
                   AND (max_uses IS NULL OR use_count < max_uses)`,
                [code.id]
            );
            if (updateRes.rowCount === 0) {
                throw new InvitationExhaustedError();
            }

            await client.query(
                `INSERT INTO invitation_code_uses (invitation_code_id, user_id)
                 VALUES ($1, $2)`,
                [code.id, user.id]
            );
        });

        process.stdout.write(JSON.stringify({
            level: 'info',
            msg: 'Customer account created',
            email,
            invitationCode,
            userId: user.id,
            ts: new Date().toISOString(),
        }) + '\n');

        const { otp, otpHash } = generateOtp();
        await OtpCodes.create(user.id, otpHash);

        mailer.sendOTP(email, otp).catch(err =>
            process.stdout.write(JSON.stringify({
                level: 'error', msg: 'OTP email failed after registration',
                to: email, error: err.message, ts: new Date().toISOString(),
            }) + '\n')
        );

        return res.status(201).json({ message: 'Registration successful. Check your email for a login code.' });
    } catch (err) {
        if (err instanceof InvitationExhaustedError) {
            return res.status(410).json({ message: 'Invitation code has reached its use limit' });
        }
        console.error('Register error:', err);
        return res.status(500).json({ message: 'Registration failed' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/request-otp  — initiate login for any user type
//
// Body: { email }
// Returns the same 200 response regardless of whether the email exists,
// to prevent user enumeration.
// ---------------------------------------------------------------------------
router.post('/request-otp', async (req, res) => {
    const { email } = req.body;

    if (!email || !EMAIL_REGEX.test(email)) {
        return res.status(400).json({ message: 'Valid email is required' });
    }

    try {
        const user = await Users.findByEmail(email);

        // Deliberate: always return 200 to prevent enumeration.
        // Internal errors still surface as 500.
        if (!user || user.status !== 'active') {
            return res.status(200).json({ message: 'If that email is registered, a login code has been sent.' });
        }

        const recent = await OtpCodes.countRecent(user.id);
        if (recent >= OtpCodes.RATE_LIMIT_MAX_REQUESTS) {
            return res.status(429).json({ message: 'Too many login attempts. Please wait before requesting another code.' });
        }

        const { otp, otpHash } = generateOtp();
        await OtpCodes.create(user.id, otpHash);

        mailer.sendOTP(email, otp).catch(err =>
            process.stdout.write(JSON.stringify({
                level: 'error', msg: 'OTP email failed on request-otp',
                to: email, error: err.message, ts: new Date().toISOString(),
            }) + '\n')
        );

        return res.status(200).json({ message: 'If that email is registered, a login code has been sent.' });
    } catch (err) {
        console.error('Request OTP error:', err);
        return res.status(500).json({ message: 'Could not process request' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/verify-otp  — complete login for any user type
//
// Body: { email, otp }
// ---------------------------------------------------------------------------
router.post('/verify-otp', async (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ message: 'email and otp are required' });
    }

    const INVALID = { message: 'Invalid or expired login code' };

    try {
        const user = await Users.findByEmail(email);
        if (!user || user.status !== 'active') {
            return res.status(401).json(INVALID);
        }

        const record = await OtpCodes.findValid(user.id);
        if (!record) {
            return res.status(401).json(INVALID);
        }

        const submittedHash = crypto.createHash('sha256').update(otp).digest('hex');
        if (submittedHash !== record.otp_hash) {
            return res.status(401).json(INVALID);
        }

        await OtpCodes.markUsed(record.id);

        let customerName = null;
        if (user.role === 'customer') {
            const customer = await Customers.findByUserId(user.id);
            customerName = customer?.name ?? null;
        }

        const { accessToken } = await issueSession(res, user);
        return res.status(200).json({
            accessToken,
            user: { id: user.id, email: user.email, role: user.role, username: user.username, customerName },
        });
    } catch (err) {
        console.error('Verify OTP error:', err);
        return res.status(500).json({ message: 'Login failed' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/refresh  — exchange a valid refresh cookie for a new
//                              access token (unchanged from prior system)
// ---------------------------------------------------------------------------
router.post('/refresh', async (req, res) => {
    const token = req.cookies[COOKIE_NAME];
    if (!token) {
        return res.status(401).json({ message: 'No refresh token' });
    }

    try {
        const record = await RefreshTokens.findByToken(token);
        if (!record) {
            return res.status(401).json({ message: 'Refresh token invalid or expired' });
        }
        if (record.status !== 'active') {
            return res.status(403).json({ message: 'Account is inactive' });
        }

        const user        = { id: record.user_id, email: record.email, role: record.role, username: record.username };
        const accessToken = await makeAccessToken(user);

        let customerName = null;
        if (user.role === 'customer') {
            const customer = await Customers.findByUserId(user.id);
            customerName = customer?.name ?? null;
        }

        return res.json({ accessToken, user: { ...user, customerName } });
    } catch (err) {
        console.error('Refresh error:', err);
        return res.status(500).json({ message: 'Token refresh failed' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/logout  — revoke refresh token and clear cookie
// ---------------------------------------------------------------------------
router.post('/logout', async (req, res) => {
    const token = req.cookies[COOKIE_NAME];
    if (token) {
        try {
            await RefreshTokens.revoke(token);
        } catch (err) {
            console.error('Logout revoke error:', err);
        }
    }
    res.clearCookie(COOKIE_NAME, cookieOpts);
    return res.json({ message: 'Logged out' });
});

module.exports = router;
