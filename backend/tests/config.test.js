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

    test('given no IMAGE_PROVIDER then images default to the local store', () => {
        const config = loadConfig({ ...BASE_ENV, ...SMTP_ENV });
        expect(config.images).toMatchObject({ provider: 'local', prefix: 'images' });
    });

    test('given an unknown IMAGE_PROVIDER then startup fails naming the valid set', () => {
        expect(() => loadConfig({ ...BASE_ENV, ...SMTP_ENV, IMAGE_PROVIDER: 'gcs' }))
            .toThrow(/IMAGE_PROVIDER must be one of \[local, s3\], got 'gcs'/);
    });

    test('given IMAGE_PROVIDER=s3 without a bucket or public base then startup fails naming both', () => {
        expect(() => loadConfig({ ...BASE_ENV, ...SMTP_ENV, IMAGE_PROVIDER: 's3' }))
            .toThrow(/S3_BUCKET.*IMAGE_PUBLIC_BASE_URL/s);
    });

    test('given IMAGE_PROVIDER=s3 fully configured then config loads with the key prefix', () => {
        const config = loadConfig({
            ...BASE_ENV, ...SMTP_ENV,
            IMAGE_PROVIDER:        's3',
            S3_BUCKET:             'store-images',
            S3_PREFIX:             '/catalog/',
            IMAGE_PUBLIC_BASE_URL: 'https://cdn.example.com/catalog/',
        });
        expect(config.images).toEqual({
            provider:      's3',
            bucket:        'store-images',
            prefix:        'catalog',
            publicBaseUrl: 'https://cdn.example.com/catalog',
        });
    });

    test('given a malformed IMAGE_PUBLIC_BASE_URL then startup fails', () => {
        expect(() => loadConfig({
            ...BASE_ENV, ...SMTP_ENV, IMAGE_PUBLIC_BASE_URL: 'cdn.example.com',
        })).toThrow(/IMAGE_PUBLIC_BASE_URL must be an http\(s\) URL, got 'cdn.example.com'/);
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

    test('given TRUST_PROXY unset then trustProxy is false (trust nobody)', () => {
        expect(loadConfig({ ...BASE_ENV, ...SMTP_ENV }).trustProxy).toBe(false);
    });

    test('given TRUST_PROXY=true/false then trustProxy is the boolean', () => {
        expect(loadConfig({ ...BASE_ENV, ...SMTP_ENV, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
        expect(loadConfig({ ...BASE_ENV, ...SMTP_ENV, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    });

    test('given a numeric TRUST_PROXY then trustProxy is that hop count as a number', () => {
        expect(loadConfig({ ...BASE_ENV, ...SMTP_ENV, TRUST_PROXY: '2' }).trustProxy).toBe(2);
        expect(loadConfig({ ...BASE_ENV, ...SMTP_ENV, TRUST_PROXY: '0' }).trustProxy).toBe(0);
    });

    test('given a non-numeric TRUST_PROXY then it passes through as a string spec', () => {
        expect(loadConfig({ ...BASE_ENV, ...SMTP_ENV, TRUST_PROXY: 'loopback' }).trustProxy)
            .toBe('loopback');
        expect(loadConfig({ ...BASE_ENV, ...SMTP_ENV, TRUST_PROXY: '10.0.0.0/8' }).trustProxy)
            .toBe('10.0.0.0/8');
    });

    test('given a negative TRUST_PROXY hop count then startup fails', () => {
        expect(() => loadConfig({ ...BASE_ENV, ...SMTP_ENV, TRUST_PROXY: '-1' }))
            .toThrow(/TRUST_PROXY hop count must be non-negative, got '-1'/);
    });
});
