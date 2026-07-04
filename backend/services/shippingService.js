'use strict';

const { DB: db } = require('../common/db');

/**
 * ShippingService — rule-based calculator backed by admin-editable tables.
 *
 * Base rate: the highest-priority active shipping_rules row whose
 * [min_subtotal, max_subtotal) range contains the order subtotal
 * (seeded: $9.95 under $50, free at $50+).
 *
 * Weight surcharge: per line whose UNIT weight exceeds the lowest band's
 * min_weight_lbs (seeded: 40 lb), the matching shipping_weight_bands
 * surcharge is added once per line — heavy items ship as freight regardless
 * of order value.
 *
 * A carrier-API adapter can replace this behind the same calculate() call.
 */
const ShippingService = (function () {

    return { calculate };

    /**
     * @param {number} subtotal
     * @param {Array<{qty:number, weight_lbs:number|null}>} lines - unit weight per line
     * @returns {Promise<{base:number, surcharge:number, total:number}>}
     */
    async function calculate(subtotal, lines = []) {
        const ruleRes = await db.query(
            `SELECT base_amount FROM shipping_rules
             WHERE status = 'active'
               AND min_subtotal <= $1
               AND (max_subtotal IS NULL OR max_subtotal > $1)
             ORDER BY priority
             LIMIT 1`,
            [subtotal]
        );
        const base = ruleRes.rows.length ? Number(ruleRes.rows[0].base_amount) : 0;

        const bandsRes = await db.query(
            `SELECT min_weight_lbs, max_weight_lbs, surcharge
             FROM shipping_weight_bands WHERE status = 'active'
             ORDER BY min_weight_lbs`
        );
        const bands = bandsRes.rows;

        let surcharge = 0;
        for (const line of lines) {
            const w = Number(line.weight_lbs) || 0;
            const band = bands.find(b =>
                w >= Number(b.min_weight_lbs) &&
                (b.max_weight_lbs == null || w < Number(b.max_weight_lbs)));
            if (band) surcharge += Number(band.surcharge);
        }

        return { base, surcharge, total: Number((base + surcharge).toFixed(2)) };
    }

}());

module.exports = ShippingService;
