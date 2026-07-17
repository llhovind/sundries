'use strict';

const { DB: db, withAudit } = require('../common/db');

/**
 * Repository for the product catalog (products + options + variants).
 * Storefront reads include per-variant availability (balances minus
 * reservations over active standard warehouses).
 */
const Products = (function () {

    const WRITABLE = ['name', 'descr', 'brand', 'status', 'sell_method', 'base_uom',
                      'min_cut_qty', 'weight_lbs', 'attributes', 'primary_image', 'notes'];

    return { list, findOne, create, update, upsertVariant, setOptions };

    /**
     * Paginated catalog list. Storefront callers get active products only;
     * admin callers pass includeInactive.
     */
    function list({ search = null, status = null, includeInactive = false, limit = 20, offset = 0 } = {}) {
        const params  = [];
        const clauses = [];
        if (search) {
            params.push('%' + search + '%');
            clauses.push(`p.name ILIKE $${params.length}`);
        }
        if (status) {
            params.push(status);
            clauses.push(`p.status = $${params.length}`);
        } else if (!includeInactive) {
            clauses.push(`p.status = 'active'`);
        }
        const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
        params.push(offset, limit);

        return db.query(
            `SELECT p.product_no, p.name, p.brand, p.descr, p.status, p.sell_method, p.base_uom,
                    p.min_cut_qty, p.primary_image,
                    MIN(v.price)                       AS price_from,
                    COUNT(v.variant_no)::int           AS variant_count,
                    COALESCE(SUM(av.qty_available), 0) AS qty_available,
                    COUNT(*) OVER()::int               AS _total
             FROM products p
             LEFT JOIN product_variants v ON v._product_no = p.product_no AND v.status = 'active'
             LEFT JOIN (
                 SELECT b._variant_no, SUM(b.qty_on_hand - b.qty_reserved) AS qty_available
                 FROM inventory_balances b
                 JOIN warehouses w ON w.warehouse_no = b._warehouse_no
                 WHERE w.wh_type = 'standard' AND w.status = 'active'
                 GROUP BY b._variant_no
             ) av ON av._variant_no = v.variant_no
             ${where}
             GROUP BY p.product_no
             ORDER BY p.name
             OFFSET $${params.length - 1} LIMIT $${params.length}`,
            params
        ).then(res => ({
            rows: res.rows.map(({ _total, ...r }) => r),
            total: res.rows.length ? res.rows[0]._total : 0,
        }));
    }

    /**
     * Full product: options with values, variants with their option values
     * and live availability.
     */
    function findOne(productNo, { includeInactive = false } = {}) {
        const statusClause = includeInactive ? '' : `AND p.status = 'active'`;
        return db.query(
            `SELECT p.* FROM products p WHERE p.product_no = $1 ${statusClause}`,
            [productNo]
        ).then(async res => {
            const product = res.rows[0];
            if (!product) return null;
            delete product.search_tsv;

            const [options, variants] = await Promise.all([
                db.query(
                    `SELECT o.option_no, o.name, o.position,
                            COALESCE(JSON_AGG(JSON_BUILD_OBJECT('value_no', ov.value_no, 'value', ov.value)
                                     ORDER BY ov.position, ov.value_no)
                                     FILTER (WHERE ov.value_no IS NOT NULL), '[]') AS values
                     FROM product_options o
                     LEFT JOIN product_option_values ov ON ov._option_no = o.option_no
                     WHERE o._product_no = $1
                     GROUP BY o.option_no
                     ORDER BY o.position, o.option_no`,
                    [productNo]
                ).then(r => r.rows),
                db.query(
                    `SELECT v.variant_no, v.sku, v.price, v.status, v.weight_lbs, v.primary_image, v.position,
                            COALESCE(av.qty_available, 0) AS qty_available,
                            COALESCE(JSON_AGG(JSON_BUILD_OBJECT('value_no', vv.value_no, 'value', ov.value,
                                                                'option', o.name, 'option_no', o.option_no)
                                     ORDER BY o.position)
                                     FILTER (WHERE vv.value_no IS NOT NULL), '[]') AS option_values
                     FROM product_variants v
                     LEFT JOIN product_variant_values vv ON vv.variant_no = v.variant_no
                     LEFT JOIN product_option_values ov  ON ov.value_no = vv.value_no
                     LEFT JOIN product_options o         ON o.option_no = ov._option_no
                     LEFT JOIN (
                         SELECT b._variant_no, SUM(b.qty_on_hand - b.qty_reserved) AS qty_available
                         FROM inventory_balances b
                         JOIN warehouses w ON w.warehouse_no = b._warehouse_no
                         WHERE w.wh_type = 'standard' AND w.status = 'active'
                         GROUP BY b._variant_no
                     ) av ON av._variant_no = v.variant_no
                     WHERE v._product_no = $1 ${includeInactive ? '' : `AND v.status = 'active'`}
                     GROUP BY v.variant_no, av.qty_available
                     ORDER BY v.position, v.variant_no`,
                    [productNo]
                ).then(r => r.rows),
            ]);
            return { ...product, options, variants };
        });
    }

    function create(data, userId) {
        const cols = WRITABLE.filter(c => data[c] !== undefined);
        if (!data.name) return Promise.reject(Object.assign(new Error('name is required'), { status: 400 }));
        const vals = cols.map(c => c === 'attributes' ? JSON.stringify(data[c]) : data[c]);
        const ph   = cols.map((_, i) => `$${i + 1}`).join(', ');
        return db.query(
            `INSERT INTO products (${cols.join(', ')}, _create_user_id, _modify_user_id)
             VALUES (${ph}, $${vals.length + 1}, $${vals.length + 1})
             RETURNING product_no`,
            [...vals, userId]
        ).then(res => res.rows[0].product_no);
    }

    function update(productNo, data, userId) {
        const cols = WRITABLE.filter(c => data[c] !== undefined);
        if (!cols.length) return Promise.reject(Object.assign(new Error('Nothing to update'), { status: 400 }));
        const sets = cols.map((c, i) => `${c} = $${i + 1}`);
        const vals = cols.map(c => c === 'attributes' ? JSON.stringify(data[c]) : data[c]);
        vals.push(userId, productNo);
        return db.query(
            `UPDATE products SET ${sets.join(', ')}, _modify_ts = NOW(), _modify_user_id = $${vals.length - 1}
             WHERE product_no = $${vals.length}
             RETURNING product_no`,
            vals
        ).then(res => res.rows[0] ? res.rows[0].product_no : null);
    }

    /**
     * Creates or updates a variant. valueNos (option values) are replaced
     * when provided, and must form a complete, unique combination: exactly
     * one value for every option the product defines.
     */
    function upsertVariant(productNo, data, userId) {
        const { variant_no, sku, price, status, weight_lbs, position, valueNos } = data;
        return withAudit(userId, async (client) => {
            let variantNo = variant_no;
            if (variantNo) {
                const res = await client.query(
                    `UPDATE product_variants
                     SET sku = COALESCE($2, sku), price = COALESCE($3, price),
                         status = COALESCE($4, status), weight_lbs = COALESCE($5, weight_lbs),
                         position = COALESCE($6, position),
                         _modify_ts = NOW(), _modify_user_id = $7
                     WHERE variant_no = $1 AND _product_no = $8
                     RETURNING variant_no`,
                    [variantNo, sku ?? null, price ?? null, status ?? null,
                     weight_lbs ?? null, position ?? null, userId, productNo]
                );
                if (!res.rows.length) throw Object.assign(new Error('Variant not found'), { status: 404 });
                if (valueNos !== undefined) {
                    await replaceVariantValues(client, productNo, variantNo, valueNos);
                }
            } else {
                if (!sku || price == null) {
                    throw Object.assign(new Error('sku and price are required for a new variant'), { status: 400 });
                }
                const res = await client.query(
                    `INSERT INTO product_variants (_product_no, sku, price, status, weight_lbs, position,
                                                   _create_user_id, _modify_user_id)
                     VALUES ($1,$2,$3,COALESCE($4,'active'),$5,COALESCE($6,0),$7,$7)
                     RETURNING variant_no`,
                    [productNo, sku, price, status ?? null, weight_lbs ?? null, position ?? null, userId]
                );
                variantNo = res.rows[0].variant_no;
                await replaceVariantValues(client, productNo, variantNo, valueNos ?? []);
            }
            return variantNo;
        });
    }

    /** Validates valueNos against the product's options, then replaces the variant's links. */
    async function replaceVariantValues(client, productNo, variantNo, valueNos) {
        await assertValidCombination(client, productNo, variantNo, valueNos);
        await client.query(`DELETE FROM product_variant_values WHERE variant_no = $1`, [variantNo]);
        for (const valueNo of valueNos) {
            await client.query(
                `INSERT INTO product_variant_values (variant_no, value_no) VALUES ($1, $2)`,
                [variantNo, valueNo]);
        }
    }

    /**
     * A combination is valid when it picks exactly one value per product
     * option and no sibling variant already claims the same set.
     */
    async function assertValidCombination(client, productNo, variantNo, valueNos) {
        const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

        const { rows: optionValues } = await client.query(
            `SELECT ov.value_no, o.option_no, o.name
             FROM product_options o
             JOIN product_option_values ov ON ov._option_no = o.option_no
             WHERE o._product_no = $1`,
            [productNo]);

        const byValueNo  = new Map(optionValues.map(r => [Number(r.value_no), r]));
        const optionNos  = new Set(optionValues.map(r => Number(r.option_no)));
        const seenOption = new Map();

        for (const valueNo of valueNos) {
            const row = byValueNo.get(Number(valueNo));
            if (!row) fail(400, `Option value ${valueNo} does not belong to this product`);
            const optionNo = Number(row.option_no);
            if (seenOption.has(optionNo)) {
                fail(400, `Only one value allowed for option "${row.name}"`);
            }
            seenOption.set(optionNo, valueNo);
        }
        if (seenOption.size < optionNos.size) {
            const missing = optionValues.find(r => !seenOption.has(Number(r.option_no)));
            fail(400, `A value for option "${missing.name}" is required`);
        }
        if (!valueNos.length) return;

        const sorted = [...valueNos].map(Number).sort((a, b) => a - b);
        const { rows: dup } = await client.query(
            `SELECT vv.variant_no
             FROM product_variant_values vv
             JOIN product_variants pv ON pv.variant_no = vv.variant_no
             WHERE pv._product_no = $1 AND vv.variant_no <> $2
             GROUP BY vv.variant_no
             HAVING ARRAY_AGG(vv.value_no ORDER BY vv.value_no) = $3::bigint[]
             LIMIT 1`,
            [productNo, variantNo, sorted]);
        if (dup.length) {
            fail(409, 'Another variant already uses this option combination');
        }
    }

    /**
     * Reconciles a product's option definitions (e.g. Color: Red, Blue)
     * against the desired state. Unchanged options/values are kept in place
     * so existing variant links survive; removals of values still assigned
     * to variants are rejected. Renames are treated as remove + add.
     * options: [{name, values: ['Red','Blue']}]
     */
    function setOptions(productNo, options, userId) {
        return withAudit(userId, async (client) => {
            const current = await loadCurrentOptions(client, productNo);
            const keptOptionNos = new Set();

            for (let i = 0; i < options.length; i++) {
                const opt      = options[i];
                const existing = current.get(opt.name);
                const optionNo = existing
                    ? await reconcileOption(client, existing, opt.values || [], i)
                    : await insertOption(client, productNo, opt.name, opt.values || [], i);
                keptOptionNos.add(optionNo);
            }

            for (const existing of current.values()) {
                if (keptOptionNos.has(existing.option_no)) continue;
                await assertValuesUnused(client, [...existing.values.values()],
                    `Cannot remove option "${existing.name}"`);
                await client.query(`DELETE FROM product_options WHERE option_no = $1`, [existing.option_no]);
            }
            return productNo;
        });
    }

    /** Current options keyed by name: name → {option_no, name, values: Map(value → value_no)}. */
    async function loadCurrentOptions(client, productNo) {
        const { rows } = await client.query(
            `SELECT o.option_no, o.name, ov.value_no, ov.value
             FROM product_options o
             LEFT JOIN product_option_values ov ON ov._option_no = o.option_no
             WHERE o._product_no = $1`,
            [productNo]);
        const byName = new Map();
        for (const row of rows) {
            if (!byName.has(row.name)) {
                byName.set(row.name, { option_no: Number(row.option_no), name: row.name, values: new Map() });
            }
            if (row.value_no != null) byName.get(row.name).values.set(row.value, Number(row.value_no));
        }
        return byName;
    }

    async function insertOption(client, productNo, name, values, position) {
        const { rows } = await client.query(
            `INSERT INTO product_options (_product_no, name, position)
             VALUES ($1, $2, $3) RETURNING option_no`,
            [productNo, name, position]);
        const optionNo = Number(rows[0].option_no);
        for (let j = 0; j < values.length; j++) {
            await client.query(
                `INSERT INTO product_option_values (_option_no, value, position)
                 VALUES ($1, $2, $3)`,
                [optionNo, values[j], j]);
        }
        return optionNo;
    }

    /** Diffs one existing option's values against the desired list. */
    async function reconcileOption(client, existing, values, position) {
        await client.query(
            `UPDATE product_options SET position = $2 WHERE option_no = $1`,
            [existing.option_no, position]);

        const removed = [...existing.values.entries()].filter(([value]) => !values.includes(value));
        if (removed.length) {
            await assertValuesUnused(client, removed.map(([, valueNo]) => valueNo),
                `Cannot remove value(s) ${removed.map(([value]) => `"${value}"`).join(', ')} of option "${existing.name}"`);
            await client.query(
                `DELETE FROM product_option_values WHERE value_no = ANY($1::bigint[])`,
                [removed.map(([, valueNo]) => valueNo)]);
        }
        for (let j = 0; j < values.length; j++) {
            const valueNo = existing.values.get(values[j]);
            if (valueNo) {
                await client.query(
                    `UPDATE product_option_values SET position = $2 WHERE value_no = $1`,
                    [valueNo, j]);
            } else {
                await client.query(
                    `INSERT INTO product_option_values (_option_no, value, position)
                     VALUES ($1, $2, $3)`,
                    [existing.option_no, values[j], j]);
            }
        }
        return existing.option_no;
    }

    /** Rejects deletion of option values that variants still reference. */
    async function assertValuesUnused(client, valueNos, context) {
        if (!valueNos.length) return;
        const { rows } = await client.query(
            `SELECT 1 FROM product_variant_values WHERE value_no = ANY($1::bigint[]) LIMIT 1`,
            [valueNos]);
        if (rows.length) {
            throw Object.assign(
                new Error(`${context}: it is still assigned to one or more variants. Update or remove those variants first.`),
                { status: 409 });
        }
    }

}());

module.exports = Products;
