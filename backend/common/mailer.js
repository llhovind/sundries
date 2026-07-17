'use strict';

/**
 * Email service module.
 *
 * Wraps the MailProvider port with structured JSON logging for every send.
 * All transport events (connection errors, send results) are logged to stdout
 * so that operators have a complete audit trail without inspecting the mail
 * server directly.
 *
 * Exports:
 *   sendOTP(email, otp)                  - deliver a one-time passcode
 *   sendOrderEvent(event, order, to)     - order lifecycle notifications
 *   sendRmaEvent(event, rma, to)         - returns (RMA) lifecycle notifications
 *   sendBackInStock(to, product)         - back-in-stock notification
 *   sendReportReady(to, run)             - stored report run finished
 */

const { getMailProvider } = require('../services/mail');

// ---------------------------------------------------------------------------
// Structured logger — all mail interactions use this, never console.log raw
// ---------------------------------------------------------------------------

function log(level, msg, extra = {}) {
    process.stdout.write(JSON.stringify({
        level,
        msg,
        ts: new Date().toISOString(),
        ...extra,
    }) + '\n');
}

// ---------------------------------------------------------------------------
// Internal send helper — all outgoing mail goes through the MailProvider
// port (SMTP or SES, selected by MAIL_PROVIDER / app_settings 'mail.provider')
// ---------------------------------------------------------------------------

async function send({ to, subject, text, html }) {
    const provider = await getMailProvider();
    log('info', 'mail send attempt', { provider: provider.provider, to, subject });

    try {
        const info = await provider.send({ to, subject, text, html });
        log('info', 'mail send accepted', {
            provider: provider.provider,
            to,
            subject,
            messageId: info && info.messageId,
        });
        return info;
    } catch (err) {
        log('error', 'mail send failed', {
            provider: provider.provider,
            to,
            subject,
            error: err.message,
            code:  err.code,
        });
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a one-time passcode to the given address.
 *
 * @param {string} email  - recipient address
 * @param {string} otp    - plaintext 6-digit OTP (not the hash)
 * @returns {Promise<void>}
 */
function sendOTP(email, otp) {
    return send({
        to:      email,
        subject: 'Your login code',
        text:    `Your one-time login code is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.`,
        html:    `<p>Your one-time login code is: <strong>${otp}</strong></p>
                  <p>This code expires in 10 minutes. Do not share it with anyone.</p>`,
    });
}

/**
 * Order lifecycle notification.
 * Fire-and-forget at call sites — callers should .catch() but not await.
 *
 * @param {string} event     - 'order_placed' | 'order_paid' | 'order_shipped' | 'order_failed' | 'new_order'
 * @param {object} order     - { ord_no, total, currency }
 * @param {string} recipient - destination address
 */
function sendOrderEvent(event, order, recipient) {
    const subjects = {
        order_placed:    `Order #${order.ord_no} received — awaiting payment`,
        order_paid:      `Order #${order.ord_no} confirmed`,
        order_shipped:   `Order #${order.ord_no} has shipped`,
        order_failed:    `Order #${order.ord_no} could not be completed`,
        new_order:       `New order #${order.ord_no} needs fulfillment`,
        backorder_ready: `Order #${order.ord_no} backordered items arrived — ready to ship`,
    };
    const subject = subjects[event] || `Order #${order.ord_no}: ${event}`;
    const text = `${subject}\n\nOrder: ${order.ord_no}\nTotal: ${order.total} ${order.currency || ''}`.trim();
    return send({ to: recipient, subject, text });
}

/**
 * Returns (RMA) lifecycle notification.
 * Fire-and-forget at call sites — callers should .catch() but not await.
 *
 * @param {string} event - 'rma_requested' | 'rma_new' | 'rma_approved' |
 *                         'rma_rejected' | 'rma_received' | 'rma_refunded'
 * @param {{rma_no:number, ord_no:number}} rma
 * @param {string} recipient - destination address
 */
function sendRmaEvent(event, rma, recipient) {
    const subjects = {
        rma_requested: `Return #${rma.rma_no} received — we're reviewing it`,
        rma_new:       `New return #${rma.rma_no} needs review`,
        rma_approved:  `Return #${rma.rma_no} approved — please send the items back`,
        rma_rejected:  `Return #${rma.rma_no} could not be accepted`,
        rma_received:  `Return #${rma.rma_no} arrived — your refund is being processed`,
        rma_refunded:  `Return #${rma.rma_no} refunded`,
    };
    const subject = subjects[event] || `Return #${rma.rma_no}: ${event}`;
    const text = `${subject}\n\nReturn: ${rma.rma_no}\nOrder: ${rma.ord_no}`;
    return send({ to: recipient, subject, text });
}

/**
 * Back-in-stock notification for a customer who asked to be told.
 * Fire-and-forget at call sites — callers should .catch() but not await.
 *
 * @param {string} recipient - destination address
 * @param {{sku:string, name:string}} product
 */
function sendBackInStock(recipient, product = {}) {
    const subject = `${product.name || 'An item you wanted'} is back in stock`;
    const text = `${subject}\n\nItem: ${product.name || ''} (${product.sku || ''})\n` +
                 `It sells first come, first served — order soon to be sure of yours.`;
    return send({ to: recipient, subject, text });
}

/**
 * Stored report run finished (succeeded or failed).
 * Fire-and-forget at call sites — callers should .catch() but not await.
 *
 * @param {string} recipient - destination address
 * @param {{name:string, run_no:number, status:string, error:?string}} run
 */
function sendReportReady(recipient, run) {
    const ok = run.status === 'succeeded';
    const subject = ok
        ? `Report ready: ${run.name}`
        : `Report failed: ${run.name}`;
    const text = ok
        ? `${subject}\n\nYour "${run.name}" report (run #${run.run_no}) has finished and is ` +
          `ready to view or download from Reports in the store admin.`
        : `${subject}\n\nGenerating "${run.name}" (run #${run.run_no}) did not complete: ` +
          `${run.error || 'unknown error'}. You can retry it from Reports in the store admin.`;
    return send({ to: recipient, subject, text });
}

module.exports = { sendOTP, sendOrderEvent, sendRmaEvent, sendBackInStock, sendReportReady };
