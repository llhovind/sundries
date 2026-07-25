'use strict';

/**
 * seedDemo.js — optional sample catalog for a fresh install.
 *
 * `npm run setup` builds a correct but empty store: roles, permissions, units,
 * warehouses and an admin, with nothing to buy. This script fills it with a
 * small demo catalog (db/demoCatalog.js) so the storefront, checkout, stock
 * view and reports can all be exercised immediately.
 *
 * Writes go through the models, not raw SQL, so demo rows are constructed the
 * same way the application constructs real ones — triggers, FIFO layers,
 * audit attribution and the search outbox all behave exactly as in production.
 *
 * Idempotent: products carry a marker in their `attributes` JSONB, and the
 * script refuses to run twice rather than duplicating the catalog.
 *
 * Usage: node db/seedDemo.js   (or `npm run seed:demo`)
 * Removal: delete the marked products in the admin UI, or
 *   DELETE FROM products WHERE attributes ? 'demo_seed';
 */

require('dotenv').config();
const { pool, DB: db }  = require('../common/db');
const Products          = require('../models/products');
const Categories        = require('../models/categories');
const Vendors           = require('../models/vendors');
const Warehouses        = require('../models/warehouses');
const InventoryService  = require('../services/inventoryService');
const { DEMO_MARKER, DEMO_WAREHOUSE_CODE, DEMO_VENDOR, DEMO_PRODUCTS } = require('./demoCatalog');

/**
 * Demo data in a live store is a support incident waiting to happen, so the
 * seeder refuses to run in production unless explicitly overridden — the same
 * stance the fake payment provider takes.
 */
function assertSeedingAllowed() {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
        throw new Error(
            'Refusing to seed demo data with NODE_ENV=production. ' +
            'Set ALLOW_DEMO_SEED=true if this really is a demo deployment.'
        );
    }
}

/**
 * Demo rows are attributed to the initial admin so audit trails and FIFO
 * layers have a real actor rather than an anonymous NULL.
 * @returns {Promise<number>} admin user id
 */
async function resolveActor() {
    const { rows } = await db.query(
        `SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1`
    );
    if (!rows.length) {
        throw new Error('No active admin user found — run `node db/bootstrap.js` first.');
    }
    return rows[0].id;
}

/** @returns {Promise<boolean>} true when a previous run already seeded this database. */
async function alreadySeeded() {
    const { rows } = await db.query(
        `SELECT 1 FROM products WHERE attributes ? $1 LIMIT 1`, [DEMO_MARKER]
    );
    return rows.length > 0;
}

/** @returns {Promise<number>} warehouse_no of the demo receiving warehouse. */
async function resolveWarehouse() {
    const warehouse = (await Warehouses.findAll())
        .find(w => w.code === DEMO_WAREHOUSE_CODE && w.status === 'active');
    if (!warehouse) {
        throw new Error(
            `Warehouse "${DEMO_WAREHOUSE_CODE}" not found or inactive — ` +
            'run `npm run migrate` so the standard warehouses are seeded.'
        );
    }
    return warehouse.warehouse_no;
}

/** Creates the demo vendor unless a vendor of that name already exists. */
async function ensureVendor(actorId) {
    const existing = (await Vendors.findAll({ search: DEMO_VENDOR.name }))
        .find(v => v.name === DEMO_VENDOR.name);
    if (existing) return existing.id;
    const created = await Vendors.create(DEMO_VENDOR, actorId);
    return created.id;
}

/**
 * Resolves category names to ids, creating the ones that do not exist yet.
 * @param {string[]} names
 * @returns {Promise<Map<string, number>>} name → id
 */
async function ensureCategories(names, actorId) {
    const { rows: existing } = await db.query(
        `SELECT id, name FROM categories WHERE name = ANY($1::text[])`, [names]
    );
    const byName = new Map(existing.map(c => [c.name, c.id]));

    for (const name of names) {
        if (byName.has(name)) continue;
        const created = await Categories.create(name, actorId);
        byName.set(name, created.id);
    }
    return byName;
}

/**
 * Flattens a product's options into a lookup so variant specs can name their
 * option values in prose ({ Color: 'Navy' }) rather than carrying ids.
 * @returns {Map<string, number>} "Option:Value" → value_no
 */
function indexOptionValues(options) {
    const index = new Map();
    for (const option of options) {
        for (const { value, value_no } of option.values) {
            index.set(`${option.name}:${value}`, value_no);
        }
    }
    return index;
}

/**
 * Translates a variant spec's option values into the valueNos the model expects.
 * @throws {Error} when a spec names a value the product does not define — a
 *         typo in demoCatalog.js must fail loudly, not silently create an
 *         incomplete variant that the storefront cannot render.
 */
function resolveValueNos(variantSpec, valueIndex, productName) {
    return Object.entries(variantSpec.values ?? {}).map(([option, value]) => {
        const valueNo = valueIndex.get(`${option}:${value}`);
        if (!valueNo) {
            throw new Error(
                `Demo catalog error: product "${productName}" variant ${variantSpec.sku} ` +
                `references unknown option value ${option}="${value}".`
            );
        }
        return valueNo;
    });
}

/**
 * Creates one product with its options, variants and opening stock.
 * @returns {Promise<{variants: number, units: number}>} counts for the summary
 */
async function seedProduct(spec, { actorId, warehouseNo, categoryIds }) {
    const productNo = await Products.create({
        name:        spec.name,
        descr:       spec.descr,
        brand:       spec.brand,
        status:      'active',
        sell_method: spec.sell_method,
        base_uom:    spec.base_uom,
        min_cut_qty: spec.min_cut_qty ?? null,
        weight_lbs:  spec.weight_lbs ?? null,
        attributes:  { [DEMO_MARKER]: true },
    }, actorId);

    await Categories.setForProduct(productNo, spec.categories.map(name => categoryIds.get(name)));

    if (spec.options.length) {
        await Products.setOptions(productNo, spec.options, actorId);
    }

    const { options } = await Products.findOne(productNo, { includeInactive: true });
    const valueIndex  = indexOptionValues(options);

    let units = 0;
    for (const [position, variantSpec] of spec.variants.entries()) {
        const variantNo = await Products.upsertVariant(productNo, {
            sku:        variantSpec.sku,
            price:      variantSpec.price,
            weight_lbs: variantSpec.weight_lbs ?? spec.weight_lbs ?? null,
            position,
            valueNos:   resolveValueNos(variantSpec, valueIndex, spec.name),
        }, actorId);

        units += await receiveOpeningStock(variantNo, variantSpec, { actorId, warehouseNo });
    }

    return { variants: spec.variants.length, units };
}

/**
 * Receives a variant's opening stock, one ledger row per FIFO layer.
 * @returns {Promise<number>} total quantity received, in the product's base UOM
 */
async function receiveOpeningStock(variantNo, variantSpec, { actorId, warehouseNo }) {
    let total = 0;
    for (const receipt of variantSpec.receipts) {
        await InventoryService.receiveStock({
            variantNo,
            warehouseNo,
            qty:      receipt.qty,
            unitCost: receipt.unitCost,
            notes:    'Opening stock (demo seed)',
        }, actorId);
        total += receipt.qty;
    }
    return total;
}

async function run() {
    assertSeedingAllowed();

    if (await alreadySeeded()) {
        console.log('Demo catalog is already present — nothing to do.');
        return;
    }

    const actorId     = await resolveActor();
    const warehouseNo = await resolveWarehouse();
    const vendorId    = await ensureVendor(actorId);
    const categoryIds = await ensureCategories(
        [...new Set(DEMO_PRODUCTS.flatMap(p => p.categories))], actorId
    );

    let variants = 0;
    let units    = 0;
    for (const spec of DEMO_PRODUCTS) {
        const result = await seedProduct(spec, { actorId, warehouseNo, categoryIds });
        variants += result.variants;
        units    += result.units;
        console.log(`  ✓ ${spec.name} (${result.variants} variant(s), ${result.units} received)`);
    }

    console.log(
        `\nSeeded ${DEMO_PRODUCTS.length} products / ${variants} variants, ` +
        `${units} units of stock into ${DEMO_WAREHOUSE_CODE}, ` +
        `and vendor "${DEMO_VENDOR.name}" (#${vendorId}).`
    );
    console.log('Browse http://localhost:5173/shop, or list variants with:');
    console.log('  curl -s localhost:3000/api/v1/products | head');
}

run()
    .catch(err => {
        console.error('Demo seed failed:', err.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
