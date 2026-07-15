'use strict';

const { DB: db } = require('../common/db');

/**
 * ShippingService — rule-based calculator backed by admin-editable tables.
 *
 * Base rate: the highest-priority active shipping_rules row whose
 * [min_subtotal, max_subtotal) range contains the order subtotal
 * (seeded: $9.95 under $50, free at $50+).
 *
 * Weight surcharge — package model, matched against shipping_weight_bands
 * (seeded: 40–70 lb and 70+ lb). Heavy packages ship as freight regardless
 * of order value:
 *   - unit goods: each unit is its own package — the band is matched on the
 *     UNIT weight and the surcharge applies per unit (qty × surcharge).
 *   - measured goods: a line is one continuous cut, i.e. one package — the
 *     band is matched on the CUT's total weight (per-UOM weight × qty) and
 *     the surcharge applies once.
 *
 * A carrier-API adapter can replace this behind the same calculate() call.
 */
const ShippingService = (function () {

    return { calculate };

    /**
     * @param {number} subtotal
     * @param {Array<{qty:number, weight_lbs:number|null, sell_method?:string}>} lines
     *        - weight_lbs is per unit / per base UOM
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
            const unitWeight = Number(line.weight_lbs) || 0;
            if (!unitWeight) continue;
            const qty       = Number(line.qty) || 0;
            const isMeasure = line.sell_method === 'measure';
            // One package per unit for unit goods; the whole cut is one
            // package for measured goods.
            const packageWeight = isMeasure ? unitWeight * qty : unitWeight;
            const packageCount  = isMeasure ? 1 : qty;
            const band = bands.find(b =>
                packageWeight >= Number(b.min_weight_lbs) &&
                (b.max_weight_lbs == null || packageWeight < Number(b.max_weight_lbs)));
            if (band) surcharge += Number(band.surcharge) * packageCount;
        }
        surcharge = Number(surcharge.toFixed(2));

        return { base, surcharge, total: Number((base + surcharge).toFixed(2)) };
    }

}());

module.exports = ShippingService;
