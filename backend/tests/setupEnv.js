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

/**
 * Jest's runtime rewrites dynamic import() to require(), so it cannot load
 * pg-boss (ESM-only since v12). The inline queue adapter needs no such import,
 * and makes a job's effects observable on the next line instead of after a
 * poll interval. The pg-boss adapter is covered separately, on a runtime that
 * can load it: tests/integration/queue.pgboss.test.mjs.
 */
process.env.QUEUE_PROVIDER = process.env.QUEUE_PROVIDER || 'inline';
