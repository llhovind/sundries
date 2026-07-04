'use strict';

/**
 * Jest setup — runs before every test file.
 *
 * Tests default to the no-op mail adapter so a test run can never email a
 * real inbox, regardless of the SMTP credentials in .env (order events go
 * to real fulfillment staff otherwise). An explicit MAIL_PROVIDER in the
 * shell still wins, and .env cannot override it (dotenv never overwrites
 * variables that are already set).
 */
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'noop';
