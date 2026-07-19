'use strict';

/**
 * Storefront API tests: products (list/detail/variants/options, staff vs
 * shopper visibility), variant-based cart, and the inventory admin routes.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../app');
const { DB: db, pool } = require('../common/db');

const RUN = Date.now();
let mainWh;

function token(user, perms = [], roles = ['customer']) {
    return jwt.sign(
        { sub: user.id, email: user.email, role: user.role || 'customer', roles, perms },
        process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }
    );
}
const staffToken = () => token({ id: 1, email: 's@t.l', role: 'admin' },
    ['catalog:write', 'inventory:read', 'inventory:receive', 'inventory:adjust'], ['admin']);

async function makeShopper(tag) {
    const u = await db.query(
        `INSERT INTO users (email, role, status) VALUES ($1, 'customer', 'active') RETURNING id, email, role`,
        [`sf-${tag}-${RUN}@example.com`]);
    return u.rows[0];
}

beforeAll(async () => {
    mainWh = (await db.query(`SELECT warehouse_no FROM warehouses WHERE code = 'MAIN'`)).rows[0].warehouse_no;
});

afterAll(async () => {
    await pool.end();
});

describe('given the products API when the catalog is managed then storefront and staff see the right things', () => {

    test('given a product with options and variants then detail returns the full picture with availability', async () => {
        // staff creates a draft product with Color options and two variants
        const created = await request(app).post('/api/v1/products')
            .set('Authorization', `Bearer ${staffToken()}`)
            .send({ name: `Tee ${RUN}`, sell_method: 'unit', base_uom: 'each', status: 'draft' });
        expect(created.status).toBe(201);
        const productNo = created.body.content.product_no;

        await request(app).put(`/api/v1/products/${productNo}/options`)
            .set('Authorization', `Bearer ${staffToken()}`)
            .send({ options: [{ name: 'Color', values: ['Red', 'Blue'] }] });

        const detailDraft = await request(app).get(`/api/v1/products/${productNo}`)
            .set('Authorization', `Bearer ${staffToken()}`);
        const values = detailDraft.body.content.product.options[0].values;

        for (const val of values) {
            const vres = await request(app).post(`/api/v1/products/${productNo}/variants`)
                .set('Authorization', `Bearer ${staffToken()}`)
                .send({ sku: `TEE-${RUN}-${val.value}`, price: 19.5, valueNos: [val.value_no] });
            expect(vres.status).toBe(201);
        }

        // shoppers cannot see drafts
        const shopper = await makeShopper('draft');
        const hidden = await request(app).get(`/api/v1/products/${productNo}`)
            .set('Authorization', `Bearer ${token(shopper)}`);
        expect(hidden.status).toBe(404);

        // activate + stock one variant
        await request(app).put(`/api/v1/products/${productNo}`)
            .set('Authorization', `Bearer ${staffToken()}`).send({ status: 'active' });
        const detail = await request(app).get(`/api/v1/products/${productNo}`)
            .set('Authorization', `Bearer ${token(shopper)}`);
        expect(detail.status).toBe(200);
        const product = detail.body.content.product;
        expect(product.variants).toHaveLength(2);
        expect(product.variants[0].option_values[0].option).toBe('Color');

        const redVariant = product.variants.find(v => v.sku.endsWith('Red'));
        await db.query(
            `INSERT INTO inventory_transactions (_trn_type, _variant_no, _warehouse_no, qty, unit_cost)
             VALUES ('IN', $1, $2, 7, 5)`, [redVariant.variant_no, mainWh]);

        const after = await request(app).get(`/api/v1/products/${productNo}`)
            .set('Authorization', `Bearer ${token(shopper)}`);
        const red = after.body.content.product.variants.find(v => v.sku.endsWith('Red'));
        const blue = after.body.content.product.variants.find(v => v.sku.endsWith('Blue'));
        expect(Number(red.qty_available)).toBe(7);
        expect(Number(blue.qty_available)).toBe(0);
    });

    test('given the list then price_from, availability and search work; shoppers cannot write', async () => {
        const shopper = await makeShopper('list');
        const list = await request(app).get(`/api/v1/products?q=Tee ${RUN}`)
            .set('Authorization', `Bearer ${token(shopper)}`);
        expect(list.status).toBe(200);
        const row = list.body.content.products[0];
        expect(Number(row.price_from)).toBe(19.5);
        expect(row.variant_count).toBe(2);
        expect(Number(row.qty_available)).toBe(7);

        const denied = await request(app).post('/api/v1/products')
            .set('Authorization', `Bearer ${token(shopper)}`)
            .send({ name: 'Hack' });
        expect(denied.status).toBe(403);
    });
});

describe('given variant option combinations when variants and options are saved then the wiring is validated', () => {

    let productNo, color, size;
    const staffGet = () => request(app).get(`/api/v1/products/${productNo}`)
        .set('Authorization', `Bearer ${staffToken()}`).then(r => r.body.content.product);
    const postVariant = (body) => request(app).post(`/api/v1/products/${productNo}/variants`)
        .set('Authorization', `Bearer ${staffToken()}`).send(body);
    const putOptions = (options) => request(app).put(`/api/v1/products/${productNo}/options`)
        .set('Authorization', `Bearer ${staffToken()}`).send({ options });
    const val = (opt, v) => opt.values.find(x => x.value === v).value_no;

    beforeAll(async () => {
        const created = await request(app).post('/api/v1/products')
            .set('Authorization', `Bearer ${staffToken()}`)
            .send({ name: `Combo ${RUN}`, status: 'active' });
        productNo = created.body.content.product_no;
        await putOptions([{ name: 'Color', values: ['Red', 'Blue'] },
                          { name: 'Size',  values: ['S', 'M'] }]);
        const product = await staffGet();
        color = product.options.find(o => o.name === 'Color');
        size  = product.options.find(o => o.name === 'Size');
    });

    test('given a complete combination then the variant is created with its option values', async () => {
        const res = await postVariant({ sku: `CMB-${RUN}-RED-S`, price: 10,
                                        valueNos: [val(color, 'Red'), val(size, 'S')] });
        expect(res.status).toBe(201);
        const product = await staffGet();
        const v = product.variants.find(x => x.sku === `CMB-${RUN}-RED-S`);
        expect(v.option_values).toHaveLength(2);
        expect(v.option_values.map(ov => ov.value).sort()).toEqual(['Red', 'S']);
    });

    test('given a missing option value then the variant is rejected', async () => {
        const res = await postVariant({ sku: `CMB-${RUN}-X1`, price: 10,
                                        valueNos: [val(color, 'Blue')] });
        expect(res.status).toBe(400);
        expect(res.body.outcome.message).toMatch(/Size/);
    });

    test('given two values of the same option then the variant is rejected', async () => {
        const res = await postVariant({ sku: `CMB-${RUN}-X2`, price: 10,
                                        valueNos: [val(color, 'Red'), val(color, 'Blue'), val(size, 'M')] });
        expect(res.status).toBe(400);
        expect(res.body.outcome.message).toMatch(/one value/i);
    });

    test('given an already-used combination then the variant is rejected as a duplicate', async () => {
        const res = await postVariant({ sku: `CMB-${RUN}-DUP`, price: 12,
                                        valueNos: [val(size, 'S'), val(color, 'Red')] });
        expect(res.status).toBe(409);
    });

    test('given a value_no from another product then the variant is rejected', async () => {
        const res = await postVariant({ sku: `CMB-${RUN}-X3`, price: 10,
                                        valueNos: [999999999, val(size, 'S')] });
        expect(res.status).toBe(400);
    });

    test('given options resubmitted with a new value then existing variant links survive', async () => {
        const res = await putOptions([{ name: 'Color', values: ['Red', 'Blue', 'Green'] },
                                      { name: 'Size',  values: ['S', 'M'] }]);
        expect(res.status).toBe(200);
        const product = await staffGet();
        expect(product.options.find(o => o.name === 'Color').values).toHaveLength(3);
        const v = product.variants.find(x => x.sku === `CMB-${RUN}-RED-S`);
        expect(v.option_values.map(ov => ov.value).sort()).toEqual(['Red', 'S']);
    });

    test('given removal of a value still assigned to a variant then options save is rejected', async () => {
        const res = await putOptions([{ name: 'Color', values: ['Blue', 'Green'] },
                                      { name: 'Size',  values: ['S', 'M'] }]);
        expect(res.status).toBe(409);
        const product = await staffGet();
        expect(product.options.find(o => o.name === 'Color').values.map(x => x.value)).toContain('Red');
    });

    test('given a duplicate option name in the payload then options save is rejected', async () => {
        const res = await putOptions([{ name: 'Color', values: ['Red'] },
                                      { name: 'Color', values: ['Blue'] }]);
        expect(res.status).toBe(400);
    });

    test('given a product without options then a plain variant saves and valueNos are rejected', async () => {
        const created = await request(app).post('/api/v1/products')
            .set('Authorization', `Bearer ${staffToken()}`)
            .send({ name: `NoOpts ${RUN}`, status: 'active' });
        const plainNo = created.body.content.product_no;
        const ok = await request(app).post(`/api/v1/products/${plainNo}/variants`)
            .set('Authorization', `Bearer ${staffToken()}`)
            .send({ sku: `NOOPT-${RUN}`, price: 5 });
        expect(ok.status).toBe(201);
        const bad = await request(app).post(`/api/v1/products/${plainNo}/variants`)
            .set('Authorization', `Bearer ${staffToken()}`)
            .send({ sku: `NOOPT-${RUN}-B`, price: 5, valueNos: [val(size, 'S')] });
        expect(bad.status).toBe(400);
    });
});

describe('given the cart API when a shopper builds a cart then lines carry snapshots and live prices', () => {

    async function makeStockedVariant(tag, price = 12) {
        const p = await db.query(
            `INSERT INTO products (name, status) VALUES ($1, 'active') RETURNING product_no`,
            [`CartProd ${tag} ${RUN}`]);
        const v = await db.query(
            `INSERT INTO product_variants (_product_no, sku, price) VALUES ($1, $2, $3) RETURNING variant_no`,
            [p.rows[0].product_no, `CART-${RUN}-${tag}`, price]);
        return Number(v.rows[0].variant_no);
    }

    test('given add/update/remove then the cart mutates and totals derive from snapshots', async () => {
        const shopper = await makeShopper('cart');
        const auth = `Bearer ${token(shopper)}`;
        const v = await makeStockedVariant('A');

        const empty = await request(app).get('/api/v1/cart').set('Authorization', auth);
        expect(empty.status).toBe(200);
        expect(empty.body.content.cart.items).toEqual([]);

        const added = await request(app).post('/api/v1/cart/items')
            .set('Authorization', auth).send({ variant_no: v, qty: 2 });
        expect(added.status).toBe(200);
        expect(added.body.content.cart.items).toHaveLength(1);
        expect(Number(added.body.content.cart.items[0].unit_price)).toBe(12);

        const updated = await request(app).put(`/api/v1/cart/items/${v}`)
            .set('Authorization', auth).send({ qty: 5 });
        expect(Number(updated.body.content.cart.items[0].qty)).toBe(5);

        // price snapshot survives a live price change; current_price reveals it
        await db.query(`UPDATE product_variants SET price = 15 WHERE variant_no = $1`, [v]);
        const drifted = await request(app).get('/api/v1/cart').set('Authorization', auth);
        expect(Number(drifted.body.content.cart.items[0].unit_price)).toBe(12);
        expect(Number(drifted.body.content.cart.items[0].current_price)).toBe(15);

        const removed = await request(app).delete(`/api/v1/cart/items/${v}`).set('Authorization', auth);
        expect(removed.body.content.cart.items).toEqual([]);
    });

    test('given the same item added twice then the line accumulates; PUT still sets an absolute qty', async () => {
        const shopper = await makeShopper('cartadd');
        const auth = `Bearer ${token(shopper)}`;
        const v = await makeStockedVariant('ACC');

        await request(app).post('/api/v1/cart/items').set('Authorization', auth).send({ variant_no: v, qty: 2 });
        const again = await request(app).post('/api/v1/cart/items')
            .set('Authorization', auth).send({ variant_no: v, qty: 3 });
        expect(again.status).toBe(200);
        expect(again.body.content.cart.items).toHaveLength(1);
        expect(Number(again.body.content.cart.items[0].qty)).toBe(5);   // add-to-cart accumulates

        const set = await request(app).put(`/api/v1/cart/items/${v}`)
            .set('Authorization', auth).send({ qty: 2 });
        expect(Number(set.body.content.cart.items[0].qty)).toBe(2);     // stepper is absolute
    });

    test('given an inactive variant then adding it is rejected', async () => {
        const shopper = await makeShopper('inactive');
        const v = await makeStockedVariant('DEAD');
        await db.query(`UPDATE product_variants SET status = 'inactive' WHERE variant_no = $1`, [v]);
        const res = await request(app).post('/api/v1/cart/items')
            .set('Authorization', `Bearer ${token(shopper)}`).send({ variant_no: v, qty: 1 });
        expect(res.status).toBe(404);
    });
});

describe('given the inventory admin API when staff manage stock then permissions and math hold', () => {

    test('given receive and adjust then balances/ledger reflect them; shoppers are 403', async () => {
        const p = await db.query(
            `INSERT INTO products (name, status) VALUES ($1, 'active') RETURNING product_no`,
            [`InvProd ${RUN}`]);
        const v = Number((await db.query(
            `INSERT INTO product_variants (_product_no, sku, price) VALUES ($1, $2, 9) RETURNING variant_no`,
            [p.rows[0].product_no, `INV-${RUN}`])).rows[0].variant_no);

        const rec = await request(app).post('/api/v1/inventory/receive')
            .set('Authorization', `Bearer ${staffToken()}`)
            .send({ variant_no: v, warehouse_no: mainWh, qty: 10, unit_cost: 3 });
        expect(rec.status).toBe(201);

        const adj = await request(app).post('/api/v1/inventory/adjust')
            .set('Authorization', `Bearer ${staffToken()}`)
            .send({ variant_no: v, warehouse_no: mainWh, qty: -2, reason_code: 'damage' });
        expect(adj.status).toBe(201);
        expect(Number(adj.body.content.unit_cost)).toBe(3);   // FIFO-stamped

        const balances = await request(app).get(`/api/v1/inventory/balances?q=INV-${RUN}`)
            .set('Authorization', `Bearer ${staffToken()}`);
        expect(balances.status).toBe(200);
        expect(Number(balances.body.content.balances[0].qty_on_hand)).toBe(8);

        const ledger = await request(app).get(`/api/v1/inventory/ledger/${v}`)
            .set('Authorization', `Bearer ${staffToken()}`);
        expect(ledger.body.content.transactions).toHaveLength(2);

        const shopper = await makeShopper('inv');
        const denied = await request(app).get('/api/v1/inventory/balances')
            .set('Authorization', `Bearer ${token(shopper)}`);
        expect(denied.status).toBe(403);
    });
});

describe('given the product image API when staff upload images then primary_image and disk stay in sync', () => {
    const fs   = require('fs/promises');
    const path = require('path');
    const UPLOADS_ROOT = path.join(__dirname, '../uploads');
    const PNG = Buffer.from('89504e470d0a1a0a', 'hex');   // content is irrelevant — only the declared type is validated

    let productNo;

    beforeAll(async () => {
        const created = await request(app).post('/api/v1/products')
            .set('Authorization', `Bearer ${staffToken()}`)
            .send({ name: `ImgProd ${RUN}`, status: 'draft' });
        productNo = created.body.content.product_no;
    });

    afterAll(async () => {
        await fs.rm(path.join(UPLOADS_ROOT, String(productNo)), { recursive: true, force: true });
    });

    test('given an image upload then primary_image is set and the file is served from disk', async () => {
        const res = await request(app).post(`/api/v1/products/${productNo}/image`)
            .set('Authorization', `Bearer ${staffToken()}`)
            .attach('image', PNG, { filename: 'photo.png', contentType: 'image/png' });
        expect(res.status).toBe(200);
        const stored = res.body.content.primary_image;
        expect(stored).toMatch(new RegExp(`^${productNo}/product-\\d+\\.png$`));
        await expect(fs.access(path.join(UPLOADS_ROOT, stored))).resolves.toBeUndefined();

        const detail = await request(app).get(`/api/v1/products/${productNo}`)
            .set('Authorization', `Bearer ${staffToken()}`);
        expect(detail.body.content.product.primary_image).toBe(stored);
    });

    test('given a replacement upload then the previous file is removed', async () => {
        const first = await request(app).post(`/api/v1/products/${productNo}/image`)
            .set('Authorization', `Bearer ${staffToken()}`)
            .attach('image', PNG, { filename: 'a.png', contentType: 'image/png' });
        const oldPath = first.body.content.primary_image;

        await new Promise(resolve => setTimeout(resolve, 5));   // generated names are timestamped
        const second = await request(app).post(`/api/v1/products/${productNo}/image`)
            .set('Authorization', `Bearer ${staffToken()}`)
            .attach('image', PNG, { filename: 'b.png', contentType: 'image/png' });
        expect(second.status).toBe(200);
        expect(second.body.content.primary_image).not.toBe(oldPath);

        await expect(fs.access(path.join(UPLOADS_ROOT, oldPath))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.access(path.join(UPLOADS_ROOT, second.body.content.primary_image))).resolves.toBeUndefined();
    });

    test('given a non-image type then the upload is rejected with 400', async () => {
        const res = await request(app).post(`/api/v1/products/${productNo}/image`)
            .set('Authorization', `Bearer ${staffToken()}`)
            .attach('image', Buffer.from('plain text'), { filename: 'notes.txt', contentType: 'text/plain' });
        expect(res.status).toBe(400);
    });

    test('given a missing file then the upload is rejected with 400', async () => {
        const res = await request(app).post(`/api/v1/products/${productNo}/image`)
            .set('Authorization', `Bearer ${staffToken()}`);
        expect(res.status).toBe(400);
    });

    test('given an unknown product then the upload is a 404 and nothing is written', async () => {
        const res = await request(app).post('/api/v1/products/999999999/image')
            .set('Authorization', `Bearer ${staffToken()}`)
            .attach('image', PNG, { filename: 'photo.png', contentType: 'image/png' });
        expect(res.status).toBe(404);
        await expect(fs.access(path.join(UPLOADS_ROOT, '999999999'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('given a shopper without catalog:write then the upload is 403', async () => {
        const shopper = await makeShopper('img');
        const res = await request(app).post(`/api/v1/products/${productNo}/image`)
            .set('Authorization', `Bearer ${token(shopper)}`)
            .attach('image', PNG, { filename: 'photo.png', contentType: 'image/png' });
        expect(res.status).toBe(403);
    });

    test('given a variant image upload and replacement then the variant primary_image and disk track it', async () => {
        const vres = await request(app).post(`/api/v1/products/${productNo}/variants`)
            .set('Authorization', `Bearer ${staffToken()}`)
            .send({ sku: `IMG-V-${RUN}`, price: 5 });
        const variantNo = vres.body.content.variant_no;

        const first = await request(app)
            .post(`/api/v1/products/${productNo}/variants/${variantNo}/image`)
            .set('Authorization', `Bearer ${staffToken()}`)
            .attach('image', PNG, { filename: 'v.png', contentType: 'image/png' });
        expect(first.status).toBe(200);
        const oldPath = first.body.content.primary_image;
        expect(oldPath).toMatch(new RegExp(`^${productNo}/variant-${variantNo}-\\d+\\.png$`));

        const detail = await request(app).get(`/api/v1/products/${productNo}`)
            .set('Authorization', `Bearer ${staffToken()}`);
        const variant = detail.body.content.product.variants.find(v => v.variant_no === variantNo);
        expect(variant.primary_image).toBe(oldPath);

        await new Promise(resolve => setTimeout(resolve, 5));   // generated names are timestamped
        const second = await request(app)
            .post(`/api/v1/products/${productNo}/variants/${variantNo}/image`)
            .set('Authorization', `Bearer ${staffToken()}`)
            .attach('image', PNG, { filename: 'v2.png', contentType: 'image/png' });
        expect(second.status).toBe(200);
        expect(second.body.content.primary_image).not.toBe(oldPath);
        await expect(fs.access(path.join(UPLOADS_ROOT, oldPath))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.access(path.join(UPLOADS_ROOT, second.body.content.primary_image))).resolves.toBeUndefined();
    });

    test('given a variant that does not belong to the product then the upload is a 404', async () => {
        const other = await request(app).post('/api/v1/products')
            .set('Authorization', `Bearer ${staffToken()}`)
            .send({ name: `ImgOther ${RUN}`, status: 'draft' });
        const otherNo = other.body.content.product_no;
        const vres = await request(app).post(`/api/v1/products/${otherNo}/variants`)
            .set('Authorization', `Bearer ${staffToken()}`)
            .send({ sku: `IMG-O-${RUN}`, price: 5 });
        const foreignVariant = vres.body.content.variant_no;

        const res = await request(app)
            .post(`/api/v1/products/${productNo}/variants/${foreignVariant}/image`)
            .set('Authorization', `Bearer ${staffToken()}`)
            .attach('image', PNG, { filename: 'v.png', contentType: 'image/png' });
        expect(res.status).toBe(404);
    });
});
