'use strict';

require('dotenv').config();

const REQUIRED_VARS = [
    'DB_HOST',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASSWORD',
    'SMTP_FROM',
];

const missing = REQUIRED_VARS.filter(name => !process.env[name]);
if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

module.exports = {
    db: {
        host:     process.env.DB_HOST,
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        name:     process.env.DB_NAME,
    },
    jwt: {
        accessSecret:      process.env.JWT_ACCESS_SECRET,
        refreshSecret:     process.env.JWT_REFRESH_SECRET,
        accessExpires:     process.env.JWT_ACCESS_EXPIRES || '15m',
        refreshExpiresDays: parseInt(process.env.JWT_REFRESH_EXPIRES, 10) || 7,
    },
    smtp: {
        host:     process.env.SMTP_HOST,
        port:     parseInt(process.env.SMTP_PORT, 10),
        user:     process.env.SMTP_USER,
        password: process.env.SMTP_PASSWORD,
        from:     process.env.SMTP_FROM,
    },
    cookie: {
        secure: process.env.COOKIE_SECURE === 'true',
    },
    port: parseInt(process.env.PORT, 10) || 3000,
    isDev: process.env.NODE_ENV !== 'production',
};
