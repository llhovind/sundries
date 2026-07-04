'use strict';

const config = require('../../common/config');

/**
 * Amazon SES adapter for the MailProvider port.
 *
 * Requires: `npm install @aws-sdk/client-sesv2`. Credentials come from the
 * standard AWS chain (env vars, instance profile, ~/.aws) — nothing custom.
 * The SDK is required lazily so SMTP-only installs don't need it.
 *
 * Env: AWS_REGION (standard), SES_FROM (optional; defaults to SMTP_FROM).
 */
const SesAdapter = (function () {

    let client = null;
    let SendEmailCommand = null;

    function ses() {
        if (!client) {
            // eslint-disable-next-line global-require
            const sdk = require('@aws-sdk/client-sesv2');
            SendEmailCommand = sdk.SendEmailCommand;
            client = new sdk.SESv2Client({
                maxAttempts: 3,
                requestHandler: { requestTimeout: 10000 },
            });
        }
        return client;
    }

    return {
        provider: 'ses',
        /** @param {{to:string, subject:string, text?:string, html?:string}} msg */
        send({ to, subject, text, html }) {
            const body = {};
            if (text) body.Text = { Data: text };
            if (html) body.Html = { Data: html };
            return ses().send(new SendEmailCommand({
                FromEmailAddress: process.env.SES_FROM || config.smtp.from,
                Destination: { ToAddresses: [to] },
                Content: { Simple: { Subject: { Data: subject }, Body: body } },
            }));
        },
    };

}());

module.exports = SesAdapter;
