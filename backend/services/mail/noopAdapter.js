'use strict';

/**
 * No-op MailProvider — accepts every message and sends nothing.
 *
 * For test runs and mail-less installs (MAIL_PROVIDER=noop): the full mail
 * pipeline still executes (provider selection, structured send logging,
 * error handling), but no message ever leaves the process. Jest and the
 * Playwright-booted backend default to this adapter so test runs cannot
 * email real inboxes, whatever SMTP credentials are configured.
 */
const NoopAdapter = {
    provider: 'noop',

    /** @param {{to:string, subject:string, text?:string, html?:string}} msg */
    send(msg) {
        return Promise.resolve({
            messageId: `noop-${Date.now()}@localhost`,
            accepted:  [msg.to],
        });
    },
};

module.exports = NoopAdapter;
