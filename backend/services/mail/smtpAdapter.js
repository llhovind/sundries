'use strict';

const nodemailer = require('nodemailer');
const config     = require('../../common/config');

/**
 * SMTP adapter (nodemailer) — the default MailProvider. Right for small
 * installs and any relay (Mailpit in dev, a datacenter relay, etc.).
 */
const SmtpAdapter = (function () {

    let transporter = null;

    function transport() {
        if (!transporter) {
            transporter = nodemailer.createTransport({
                host:   config.smtp.host,
                port:   config.smtp.port,
                secure: config.smtp.port === 465,
                auth: {
                    user: config.smtp.user,
                    pass: config.smtp.password,
                },
            });
        }
        return transporter;
    }

    return {
        provider: 'smtp',
        /** @param {{to:string, subject:string, text?:string, html?:string}} msg */
        send(msg) {
            return transport().sendMail({ from: config.smtp.from, ...msg });
        },
    };

}());

module.exports = SmtpAdapter;
