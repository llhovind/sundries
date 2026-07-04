'use strict';

const { DB: db } = require('../common/db');

/**
 * TaxService — pluggable tax calculation port.
 *
 * Adapters:
 *   'local'  — tax_rates table lookup (country → state → most specific wins).
 *              Seeded with a 0% US default; small shops maintain their own rows.
 *   'stripe' — Stripe Tax. Not yet implemented: it computes tax on the
 *              PaymentIntent/invoice at Stripe's side; wiring it means passing
 *              line items + address to the Stripe adapter. Falls back to
 *              'local' with a structured warning until then, so checkout
 *              never breaks on configuration alone.
 *
 * Selection: app_settings 'tax.provider' (admin-editable), default 'local'.
 */
const TaxService = (function () {

    return { calculate };

    /**
     * @param {number} taxableAmount - subtotal (+ shipping where applicable)
     * @param {{country?:string, state?:string}} address - destination
     * @returns {Promise<{rate:number, tax:number, provider:string}>}
     */
    async function calculate(taxableAmount, address = {}) {
        const setting  = await db.query(`SELECT value FROM app_settings WHERE key = 'tax.provider'`);
        const provider = setting.rows.length ? JSON.parse(JSON.stringify(setting.rows[0].value)) : 'local';

        if (provider === 'stripe') {
            process.stdout.write(JSON.stringify({
                level: 'warn', msg: 'tax.provider=stripe not yet wired; using local tax_rates',
                ts: new Date().toISOString(),
            }) + '\n');
        }

        const country = (address.country || 'US').toUpperCase();
        const state   = address.state ? address.state.toUpperCase() : null;

        // Most specific active rate wins: country+state beats country-wide.
        const res = await db.query(
            `SELECT rate FROM tax_rates
             WHERE status = 'active'
               AND UPPER(country) = $1
               AND (state IS NULL OR UPPER(state) = $2)
             ORDER BY state NULLS LAST
             LIMIT 1`,
            [country, state]
        );
        const rate = res.rows.length ? Number(res.rows[0].rate) : 0;
        return {
            rate,
            tax: Number((taxableAmount * rate).toFixed(2)),
            provider: 'local',
        };
    }

}());

module.exports = TaxService;
