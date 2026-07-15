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
