'use strict';

/**
 * demoCatalog.js — the sample catalog used by `npm run seed:demo`.
 *
 * Data only: no I/O, no SQL, no ordering assumptions. db/seedDemo.js knows how
 * to insert this shape; this file knows what a newcomer should see on their
 * first run. The three products are chosen to exercise the three selling models
 * the engine supports, so the storefront, stock view and reports all have
 * something meaningful in them immediately:
 *
 *   1. a plain unit good (one variant, no options)
 *   2. a unit good with an option matrix (Color × Size → 6 variants)
 *   3. a measured good sold by the foot (cut-to-length, fractional quantities)
 *
 * Receipts are deliberately split into two layers at different unit costs for
 * some variants: FIFO costing is invisible in a catalog with a single cost
 * layer, and it is the part of this system most worth seeing work.
 */

/** Stamped into products.attributes so the seeder can recognise its own rows. */
const DEMO_MARKER = 'demo_seed';

/** Warehouse the demo stock is received into (seeded by 002_seed_data.sql). */
const DEMO_WAREHOUSE_CODE = 'MAIN';

/** Vendor the demo purchase history is attributed to. */
const DEMO_VENDOR = {
    name:    'Northwind Supply Co.',
    address: '400 Harbour Road',
    city:    'Portland',
    state:   'OR',
    zip:     '97204',
    country: 'US',
    phone:   '+1-503-555-0142',
    website: 'https://northwind.example',
    notes:   'Demo vendor created by `npm run seed:demo`.',
};

/**
 * @typedef {Object} DemoVariant
 * @property {string} sku
 * @property {number} price                 Per base_uom.
 * @property {number} [weight_lbs]
 * @property {Record<string, string>} [values]  Option name → option value.
 * @property {Array<{qty: number, unitCost: number}>} receipts  FIFO layers, oldest first.
 */

/**
 * @typedef {Object} DemoProduct
 * @property {string}   name
 * @property {string}   descr
 * @property {string}   brand
 * @property {'unit'|'measure'} sell_method
 * @property {string}   base_uom
 * @property {number}   [min_cut_qty]       Measured goods only.
 * @property {number}   [weight_lbs]        Per base_uom; drives shipping surcharges.
 * @property {string[]} categories
 * @property {Array<{name: string, values: string[]}>} options
 * @property {DemoVariant[]} variants
 */

/** @type {DemoProduct[]} */
const DEMO_PRODUCTS = [
    {
        name:        'Cast Iron Skillet, 10 inch',
        descr:       'Pre-seasoned cast iron skillet with a helper handle. Oven safe to 500°F.',
        brand:       'Ironworks',
        sell_method: 'unit',
        base_uom:    'each',
        weight_lbs:  5.2,
        categories:  ['Kitchen'],
        options:     [],
        variants: [
            {
                sku: 'SKILLET-10',
                price: 39.00,
                weight_lbs: 5.2,
                // Two layers: the second shipment cost more. An order large
                // enough to span both is costed across the two rates.
                receipts: [
                    { qty: 40, unitCost: 18.50 },
                    { qty: 25, unitCost: 21.75 },
                ],
            },
        ],
    },

    {
        name:        'Classic T-Shirt',
        descr:       'Mid-weight combed cotton tee, pre-shrunk, in three sizes and two colours.',
        brand:       'Everyday',
        sell_method: 'unit',
        base_uom:    'each',
        weight_lbs:  0.4,
        categories:  ['Apparel'],
        options: [
            { name: 'Color', values: ['Navy', 'Sand'] },
            { name: 'Size',  values: ['S', 'M', 'L'] },
        ],
        // A complete 2 × 3 matrix: the variant validator requires exactly one
        // value per option, so every combination must be present.
        variants: [
            { sku: 'TEE-NVY-S', price: 24.00, values: { Color: 'Navy', Size: 'S' }, receipts: [{ qty: 12, unitCost: 8.10 }] },
            { sku: 'TEE-NVY-M', price: 24.00, values: { Color: 'Navy', Size: 'M' }, receipts: [{ qty: 30, unitCost: 8.10 }, { qty: 18, unitCost: 8.60 }] },
            { sku: 'TEE-NVY-L', price: 24.00, values: { Color: 'Navy', Size: 'L' }, receipts: [{ qty: 20, unitCost: 8.10 }] },
            { sku: 'TEE-SND-S', price: 24.00, values: { Color: 'Sand', Size: 'S' }, receipts: [{ qty: 9,  unitCost: 8.30 }] },
            { sku: 'TEE-SND-M', price: 24.00, values: { Color: 'Sand', Size: 'M' }, receipts: [{ qty: 22, unitCost: 8.30 }] },
            // Deliberately left with no receipts: an out-of-stock variant so the
            // backorder / notify-me path is reachable without emptying stock first.
            { sku: 'TEE-SND-L', price: 24.00, values: { Color: 'Sand', Size: 'L' }, receipts: [] },
        ],
    },

    {
        name:        'Cotton Canvas, 60in Wide',
        descr:       '10 oz cotton duck canvas, sold by the foot off a 60-inch roll. '
                   + 'Cut to any length at or above the one-foot minimum.',
        brand:       'Millhouse',
        sell_method: 'measure',
        base_uom:    'ft',
        min_cut_qty: 1,
        weight_lbs:  0.55,          // per foot
        categories:  ['Textiles'],
        options: [
            { name: 'Color', values: ['Natural', 'Indigo'] },
        ],
        variants: [
            {
                sku: 'CANVAS-60-NAT',
                price: 12.50,        // per foot
                values: { Color: 'Natural' },
                receipts: [
                    { qty: 300, unitCost: 5.40 },
                    { qty: 150, unitCost: 5.95 },
                ],
            },
            {
                sku: 'CANVAS-60-IND',
                price: 14.00,
                values: { Color: 'Indigo' },
                receipts: [{ qty: 180, unitCost: 6.70 }],
            },
        ],
    },
];

module.exports = { DEMO_MARKER, DEMO_WAREHOUSE_CODE, DEMO_VENDOR, DEMO_PRODUCTS };
