'use strict';

/**
 * Unit tests for common/config startup validation.
 *
 * dotenv is mocked out so the developer's real .env cannot backfill variables
 * a test deliberately leaves unset. Each case loads config in an isolated
 * module registry against a fully controlled process.env.
 */

jest.mock('dotenv', () => ({ config: () => ({}) }));

const BASE_ENV = {
    NODE_ENV:           'test',
    DB_HOST:            'localhost',
    DB_USER:            'store_web',
    DB_PASSWORD:        'pw',
    DB_NAME:            'store',
    JWT_ACCESS_SECRET:  'access-secret',
    JWT_REFRESH_SECRET: 'refresh-secret',
};

const SMTP_ENV = {
    SMTP_HOST:     'smtp.example.com',
    SMTP_PORT:     '587',
    SMTP_USER:     'mailer',
    SMTP_PASSWORD: 'pw',
    SMTP_FROM:     'noreply@example.com',
};

function loadConfig(env) {
    const saved = process.env;
    process.env = { ...env };
    try {
        let config;
        jest.isolateModules(() => {
            config = require('../common/config');
        });
        return config;
    } finally {
        process.env = saved;
    }
}

describe('common/config startup validation', () => {

    test('given all base and SMTP vars when loading then config is built', () => {
        const config = loadConfig({ ...BASE_ENV, ...SMTP_ENV });
        expect(config.db.host).toBe('localhost');
        expect(config.smtp.port).toBe(587);
    });

    test('given MAIL_PROVIDER=noop when SMTP vars are absent then config loads', () => {
        expect(() => loadConfig({ ...BASE_ENV, MAIL_PROVIDER: 'noop' })).not.toThrow();
    });

    test('given no MAIL_PROVIDER when SMTP vars are absent then startup fails naming them', () => {
        expect(() => loadConfig(BASE_ENV)).toThrow(/SMTP_HOST.*SMTP_FROM/s);
    });

    test('given MAIL_PROVIDER=smtp when SMTP vars are absent then startup fails', () => {
        expect(() => loadConfig({ ...BASE_ENV, MAIL_PROVIDER: 'smtp' })).toThrow(/SMTP_HOST/);
    });

    test('given MAIL_PROVIDER=ses with SES_FROM when SMTP vars are absent then config loads', () => {
        expect(() => loadConfig({
            ...BASE_ENV, MAIL_PROVIDER: 'ses', SES_FROM: 'noreply@example.com',
        })).not.toThrow();
    });

    test('given MAIL_PROVIDER=ses without SES_FROM then SMTP_FROM is required', () => {
        expect(() => loadConfig({ ...BASE_ENV, MAIL_PROVIDER: 'ses' })).toThrow(/SMTP_FROM/);
        expect(() => loadConfig({
            ...BASE_ENV, MAIL_PROVIDER: 'ses', SMTP_FROM: 'noreply@example.com',
        })).not.toThrow();
    });

    test('given an unknown MAIL_PROVIDER then startup fails naming the valid set', () => {
        expect(() => loadConfig({ ...BASE_ENV, MAIL_PROVIDER: 'sendgrid' }))
            .toThrow(/MAIL_PROVIDER must be one of \[smtp, ses, noop\], got 'sendgrid'/);
    });

    test('given an unknown PAYMENT_PROVIDER then startup fails naming the valid set', () => {
        expect(() => loadConfig({ ...BASE_ENV, ...SMTP_ENV, PAYMENT_PROVIDER: 'paypal' }))
            .toThrow(/PAYMENT_PROVIDER must be one of \[fake, stripe\], got 'paypal'/);
    });

    test('given PAYMENT_PROVIDER=stripe without keys then startup fails naming both keys', () => {
        expect(() => loadConfig({ ...BASE_ENV, ...SMTP_ENV, PAYMENT_PROVIDER: 'stripe' }))
            .toThrow(/STRIPE_SECRET_KEY.*STRIPE_WEBHOOK_SECRET/s);
    });

    test('given PAYMENT_PROVIDER=stripe with both keys then config loads', () => {
        expect(() => loadConfig({
            ...BASE_ENV, ...SMTP_ENV,
            PAYMENT_PROVIDER:      'stripe',
            STRIPE_SECRET_KEY:     'sk_test_x',
            STRIPE_WEBHOOK_SECRET: 'whsec_x',
        })).not.toThrow();
    });

    test('given NODE_ENV=production without COOKIE_SECURE then startup fails', () => {
        expect(() => loadConfig({ ...BASE_ENV, ...SMTP_ENV, NODE_ENV: 'production' }))
            .toThrow(/COOKIE_SECURE must be 'true' when NODE_ENV is 'production'/);
        expect(() => loadConfig({
            ...BASE_ENV, ...SMTP_ENV, NODE_ENV: 'production', COOKIE_SECURE: 'false',
        })).toThrow(/COOKIE_SECURE/);
    });

    test('given NODE_ENV=production with COOKIE_SECURE=true then config loads', () => {
        expect(() => loadConfig({
            ...BASE_ENV, ...SMTP_ENV, NODE_ENV: 'production', COOKIE_SECURE: 'true',
        })).not.toThrow();
    });

    test('given several problems at once then all are reported in one error', () => {
        expect(() => loadConfig({ ...BASE_ENV, MAIL_PROVIDER: 'bogus', PAYMENT_PROVIDER: 'bogus' }))
            .toThrow(/MAIL_PROVIDER.*PAYMENT_PROVIDER/s);
    });
});
