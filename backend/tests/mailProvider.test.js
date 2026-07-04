'use strict';

/**
 * MailProvider registry tests: adapter selection by MAIL_PROVIDER and the
 * noop adapter's contract (accept everything, send nothing). No DB rows are
 * touched — env selection short-circuits before the app_settings lookup.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { getMailProvider } = require('../services/mail');
const mailer = require('../common/mailer');
const { pool } = require('../common/db');

const ORIGINAL_PROVIDER = process.env.MAIL_PROVIDER;

afterEach(() => {
    process.env.MAIL_PROVIDER = ORIGINAL_PROVIDER;
});

afterAll(async () => {
    await pool.end();
});

describe('given the MailProvider registry when MAIL_PROVIDER is set then the matching adapter is used', () => {

    test('given noop then messages are accepted without any network send', async () => {
        process.env.MAIL_PROVIDER = 'noop';
        const provider = await getMailProvider();
        expect(provider.provider).toBe('noop');

        const info = await provider.send({ to: 'nobody@example.com', subject: 'x', text: 'y' });
        expect(info.messageId).toMatch(/^noop-/);
        expect(info.accepted).toEqual(['nobody@example.com']);
    });

    test('given noop then the full mailer pipeline resolves end to end', async () => {
        process.env.MAIL_PROVIDER = 'noop';
        await expect(mailer.sendOTP('nobody@example.com', '123456')).resolves.toBeDefined();
        await expect(mailer.sendOrderEvent('order_paid',
            { ord_no: 1, total: 10, currency: 'USD' }, 'nobody@example.com')).resolves.toBeDefined();
    });

    test('given smtp then the smtp adapter is selected', async () => {
        process.env.MAIL_PROVIDER = 'smtp';
        expect((await getMailProvider()).provider).toBe('smtp');
    });

    test('given an unknown provider then selection fails loudly', async () => {
        process.env.MAIL_PROVIDER = 'bogus';
        await expect(getMailProvider()).rejects.toThrow('Unknown mail provider: bogus');
    });

    test('given a test run then MAIL_PROVIDER defaults to noop so real inboxes are never emailed', () => {
        // setupEnv.js sets this before .env loads; dotenv cannot override it
        expect(ORIGINAL_PROVIDER).toBe('noop');
    });
});
