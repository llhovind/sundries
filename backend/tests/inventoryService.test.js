'use strict';

/**
 * Inventory core integration tests.
 *
 * These run against a real PostgreSQL database (same .env as the app) because
 * the behavior under test lives substantially IN the database: balance
 * triggers, FIFO layer consumption, reservation functions, CHECK guards and
 * ledger immutability. Run them against a disposable database created with
 * `npm run migrate` — ledger rows are append-only by design, so tests create
 * unique fixtures per run instead of deleting history.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { DB: db, pool }     = require('../common/db');
const InventoryService     = require('../services/inventoryService');
const StockTransferService = require('../services/stockTransferService');
const InventoryBalances    = require('../models/inventoryBalances');

const RUN = Date.now();          // unique suffix so repeated runs never collide
const USER_ID = 1;

let mainWh, transitWh, secondWh;
let productNo;

/** Creates a fresh variant of the shared test product. */
async function makeVariant(tag, price = 10) {
    const res = await db.query(
        `INSERT INTO product_variants (_product_no, sku, price)
         VALUES ($1, $2, $3) RETURNING variant_no`,
        [productNo, `TEST-${RUN}-${tag}`, price]
    );
    return res.rows[0].variant_no;
}

/** Creates a pending_payment order with one line for the variant. */
async function makeOrder(variantNo, qty, unitPrice = 10) {
    const cust = await db.query(
        `INSERT INTO customers (name, email, is_guest)
         VALUES ($1, $2, TRUE) RETURNING id`,
        [`Test Customer ${RUN}`, `test-${RUN}@example.com`]
    );
    const ord = await db.query(
        `INSERT INTO orders (_customer_id, email, subtotal, total)
         VALUES ($1, $2, $3, $3) RETURNING ord_no`,
        [cust.rows[0].id, `test-${RUN}@example.com`, qty * unitPrice]
    );
    const line = await db.query(
        `INSERT INTO order_lines (_ord_no, ln_no, _variant_no, qty, unit_price, line_total)
         VALUES ($1, 1, $2, $3, $4, $5) RETURNING id`,
        [ord.rows[0].ord_no, variantNo, qty, unitPrice, qty * unitPrice]
    );
    return { ordNo: ord.rows[0].ord_no, orderLineId: line.rows[0].id };
}

async function balance(variantNo, warehouseNo) {
    const res = await db.query(
        `SELECT qty_on_hand, qty_reserved FROM inventory_balances
         WHERE _variant_no = $1 AND _warehouse_no = $2`,
        [variantNo, warehouseNo]
    );
    return res.rows[0] || { qty_on_hand: 0, qty_reserved: 0 };
}

beforeAll(async () => {
    const wh = await db.query(`SELECT warehouse_no, code, wh_type FROM warehouses ORDER BY priority`);
    mainWh    = wh.rows.find(w => w.code === 'MAIN').warehouse_no;
    transitWh = wh.rows.find(w => w.wh_type === 'transport').warehouse_no;

    const second = await db.query(
        `INSERT INTO warehouses (code, name, wh_type, priority)
         VALUES ($1, 'Second (test)', 'standard', 50) RETURNING warehouse_no`,
        [`TEST2-${RUN}`]
    );
    secondWh = second.rows[0].warehouse_no;

    const prod = await db.query(
        `INSERT INTO products (name, status, sell_method, base_uom)
         VALUES ($1, 'active', 'unit', 'each') RETURNING product_no`,
        [`Test Product ${RUN}`]
    );
    productNo = prod.rows[0].product_no;
});

afterAll(async () => {
    await pool.end();
});

describe('given stock is received when the ledger row is written then derived state follows', () => {

    test('given a receipt when inserted then balance and a FIFO layer are created by triggers', async () => {
        const v = await makeVariant('RCV');
        await InventoryService.receiveStock(
            { variantNo: v, warehouseNo: mainWh, qty: 10, unitCost: 2.5 }, USER_ID);

        const bal = await balance(v, mainWh);
        expect(Number(bal.qty_on_hand)).toBe(10);
        expect(Number(bal.qty_reserved)).toBe(0);

        const layers = await db.query(
            `SELECT qty_received, qty_remaining, unit_cost FROM inventory_cost_layers
             WHERE _variant_no = $1 AND _warehouse_no = $2`, [v, mainWh]);
        expect(layers.rows).toHaveLength(1);
        expect(Number(layers.rows[0].qty_remaining)).toBe(10);
        expect(Number(layers.rows[0].unit_cost)).toBe(2.5);
    });

    test('given a receipt without unit_cost when inserted then the DB rejects it', async () => {
        const v = await makeVariant('NOCOST');
        await expect(
            db.query(
                `INSERT INTO inventory_transactions (_trn_type, _variant_no, _warehouse_no, qty)
                 VALUES ('IN', $1, $2, 5)`, [v, mainWh])
        ).rejects.toThrow(/unit_cost is required/);
    });

    test('given ledger rows exist when UPDATE or DELETE is attempted then the DB refuses (immutability)', async () => {
        const v = await makeVariant('IMM');
        await InventoryService.receiveStock(
            { variantNo: v, warehouseNo: mainWh, qty: 1, unitCost: 1 }, USER_ID);

        await expect(
            db.query(`UPDATE inventory_transactions SET qty = 99 WHERE _variant_no = $1`, [v])
        ).rejects.toThrow(/immutable/);
        await expect(
            db.query(`DELETE FROM inventory_transactions WHERE _variant_no = $1`, [v])
        ).rejects.toThrow(/immutable/);
    });
});

describe('given multiple receipt costs when stock is issued then FIFO costing applies', () => {

    test('given two layers at different costs when an issue spans both then unit_cost is the blended FIFO cost', async () => {
        const v = await makeVariant('FIFO');
        await InventoryService.receiveStock({ variantNo: v, warehouseNo: mainWh, qty: 10, unitCost: 1.0 }, USER_ID);
        await InventoryService.receiveStock({ variantNo: v, warehouseNo: mainWh, qty: 10, unitCost: 2.0 }, USER_ID);

        // Issue 15: consumes 10 @ 1.00 + 5 @ 2.00 = 20.00 → 1.333333/unit
        const trn = await InventoryService.writeOff(
            { variantNo: v, warehouseNo: mainWh, qty: 15, reasonCode: 'test' }, USER_ID);
        expect(Number(trn.unit_cost)).toBeCloseTo(20.0 / 15, 5);

        const layers = await db.query(
            `SELECT qty_remaining FROM inventory_cost_layers
             WHERE _variant_no = $1 ORDER BY layer_no`, [v]);
        expect(Number(layers.rows[0].qty_remaining)).toBe(0);
        expect(Number(layers.rows[1].qty_remaining)).toBe(5);
    });

    test('given no cost layers when an issue is attempted then the DB rejects it', async () => {
        const v = await makeVariant('NOLAYER');
        await expect(
            InventoryService.writeOff({ variantNo: v, warehouseNo: mainWh, qty: 1 }, USER_ID)
        ).rejects.toThrow(/Insufficient FIFO cost layers|balances_on_hand_covers_reserved/);
    });
});

describe('given stock on hand when orders reserve it then oversell is impossible', () => {

    test('given sufficient stock when reserved then balance reserved rises and the line is allocated', async () => {
        const v = await makeVariant('RES');
        await InventoryService.receiveStock({ variantNo: v, warehouseNo: mainWh, qty: 5, unitCost: 1 }, USER_ID);
        const { ordNo, orderLineId } = await makeOrder(v, 3);

        const reservations = await InventoryService.reserveForOrder(
            ordNo, [{ orderLineId, variantNo: v, qty: 3 }], USER_ID);

        expect(reservations).toHaveLength(1);
        const bal = await balance(v, mainWh);
        expect(Number(bal.qty_reserved)).toBe(3);

        const line = await db.query(`SELECT fulfillment_status, _warehouse_no FROM order_lines WHERE id = $1`, [orderLineId]);
        expect(line.rows[0].fulfillment_status).toBe('reserved');
        expect(Number(line.rows[0]._warehouse_no)).toBe(Number(mainWh));
    });

    test('given insufficient stock when reserved then ReservationError reports availability and nothing is held', async () => {
        const v = await makeVariant('SHORT');
        await InventoryService.receiveStock({ variantNo: v, warehouseNo: mainWh, qty: 2, unitCost: 1 }, USER_ID);
        const { ordNo, orderLineId } = await makeOrder(v, 5);

        await expect(
            InventoryService.reserveForOrder(ordNo, [{ orderLineId, variantNo: v, qty: 5 }], USER_ID)
        ).rejects.toMatchObject({
            name: 'ReservationError',
            failures: [{ variant_no: Number(v), qty: 5, qty_available: 2 }],
        });

        const bal = await balance(v, mainWh);
        expect(Number(bal.qty_reserved)).toBe(0);   // all-or-nothing rollback
    });

    test('given one unit left when two orders race then exactly one reservation wins', async () => {
        const v = await makeVariant('RACE');
        await InventoryService.receiveStock({ variantNo: v, warehouseNo: mainWh, qty: 1, unitCost: 1 }, USER_ID);
        const a = await makeOrder(v, 1);
        const b = await makeOrder(v, 1);

        const results = await Promise.allSettled([
            InventoryService.reserveForOrder(a.ordNo, [{ orderLineId: a.orderLineId, variantNo: v, qty: 1 }], USER_ID),
            InventoryService.reserveForOrder(b.ordNo, [{ orderLineId: b.orderLineId, variantNo: v, qty: 1 }], USER_ID),
        ]);

        const wins   = results.filter(r => r.status === 'fulfilled');
        const losses = results.filter(r => r.status === 'rejected');
        expect(wins).toHaveLength(1);
        expect(losses).toHaveLength(1);
        expect(losses[0].reason.name).toBe('ReservationError');

        const bal = await balance(v, mainWh);
        expect(Number(bal.qty_reserved)).toBe(1);
    });

    test('given a reservation when released then the stock is sellable again and release is idempotent', async () => {
        const v = await makeVariant('REL');
        await InventoryService.receiveStock({ variantNo: v, warehouseNo: mainWh, qty: 4, unitCost: 1 }, USER_ID);
        const { ordNo, orderLineId } = await makeOrder(v, 4);
        await InventoryService.reserveForOrder(ordNo, [{ orderLineId, variantNo: v, qty: 4 }], USER_ID);

        expect(await InventoryService.releaseOrderReservations(ordNo)).toBe(1);
        expect(await InventoryService.releaseOrderReservations(ordNo)).toBe(0);   // idempotent

        const bal = await balance(v, mainWh);
        expect(Number(bal.qty_reserved)).toBe(0);
        expect(Number(bal.qty_on_hand)).toBe(4);

        const line = await db.query(`SELECT fulfillment_status FROM order_lines WHERE id = $1`, [orderLineId]);
        expect(line.rows[0].fulfillment_status).toBe('pending');
    });

    test('given a reservation when payment confirms then consumption writes a FIFO-costed OUT row', async () => {
        const v = await makeVariant('CONS');
        await InventoryService.receiveStock({ variantNo: v, warehouseNo: mainWh, qty: 6, unitCost: 3 }, USER_ID);
        const { ordNo, orderLineId } = await makeOrder(v, 6, 9.99);
        await InventoryService.reserveForOrder(ordNo, [{ orderLineId, variantNo: v, qty: 6 }], USER_ID);

        const issued = await InventoryService.consumeOrderReservations(ordNo, USER_ID);
        expect(issued).toHaveLength(1);
        expect(Number(issued[0].unit_cost)).toBe(3);

        const bal = await balance(v, mainWh);
        expect(Number(bal.qty_on_hand)).toBe(0);
        expect(Number(bal.qty_reserved)).toBe(0);

        const out = await db.query(
            `SELECT _trn_type, qty, unit_price FROM inventory_transactions
             WHERE _lnk_table = 'orders' AND _lnk_id = $1`, [ordNo]);
        expect(out.rows[0]._trn_type).toBe('OUT');
        expect(Number(out.rows[0].qty)).toBe(-6);
        expect(Number(out.rows[0].unit_price)).toBe(9.99);
    });

    test('given an expired reservation when the sweeper runs then the stock is freed', async () => {
        const v = await makeVariant('EXP');
        await InventoryService.receiveStock({ variantNo: v, warehouseNo: mainWh, qty: 2, unitCost: 1 }, USER_ID);
        const { ordNo, orderLineId } = await makeOrder(v, 2);
        // TTL of 0 minutes → expires immediately
        await InventoryService.reserveForOrder(ordNo, [{ orderLineId, variantNo: v, qty: 2 }], USER_ID, 0);

        const released = await InventoryService.expireReservations();
        expect(released).toBeGreaterThanOrEqual(1);

        const bal = await balance(v, mainWh);
        expect(Number(bal.qty_reserved)).toBe(0);

        const res = await db.query(
            `SELECT status FROM inventory_reservations WHERE _ord_no = $1`, [ordNo]);
        expect(res.rows[0].status).toBe('expired');
    });
});

describe('given multi-warehouse stock when transfers run then in-transit goods stay visible and costed', () => {

    test('given a dispatched transfer then stock sits in the transport warehouse until received', async () => {
        const v = await makeVariant('XFER');
        await InventoryService.receiveStock({ variantNo: v, warehouseNo: mainWh, qty: 8, unitCost: 4 }, USER_ID);

        const transferNo = await StockTransferService.create({
            fromWarehouseNo: mainWh,
            toWarehouseNo: secondWh,
            transportWarehouseNo: transitWh,
            carrier: 'UPS', manifestId: `M-${RUN}`, billingNo: `B-${RUN}`,
            lines: [{ variantNo: v, qty: 5 }],
        }, USER_ID);

        await StockTransferService.dispatch(transferNo, USER_ID);
        expect(Number((await balance(v, mainWh)).qty_on_hand)).toBe(3);
        expect(Number((await balance(v, transitWh)).qty_on_hand)).toBe(5);   // visible in transit

        await StockTransferService.receive(transferNo, USER_ID);
        expect(Number((await balance(v, transitWh)).qty_on_hand)).toBe(0);
        expect(Number((await balance(v, secondWh)).qty_on_hand)).toBe(5);

        // Cost travelled with the goods: issuing at the destination costs 4.00
        const trn = await InventoryService.writeOff(
            { variantNo: v, warehouseNo: secondWh, qty: 5, reasonCode: 'test' }, USER_ID);
        expect(Number(trn.unit_cost)).toBe(4);

        // Full audit trail: 4 ledger rows linked to the transfer document
        const ledger = await db.query(
            `SELECT COUNT(*)::int AS n FROM inventory_transactions
             WHERE _lnk_table = 'stock_transfers' AND _lnk_id = $1`, [transferNo]);
        expect(ledger.rows[0].n).toBe(4);
    });

    test('given a draft transfer when dispatched twice then the second dispatch is rejected', async () => {
        const v = await makeVariant('XDUP');
        await InventoryService.receiveStock({ variantNo: v, warehouseNo: mainWh, qty: 2, unitCost: 1 }, USER_ID);
        const transferNo = await StockTransferService.create({
            fromWarehouseNo: mainWh, toWarehouseNo: secondWh, transportWarehouseNo: transitWh,
            lines: [{ variantNo: v, qty: 2 }],
        }, USER_ID);

        await StockTransferService.dispatch(transferNo, USER_ID);
        await expect(StockTransferService.dispatch(transferNo, USER_ID))
            .rejects.toMatchObject({ status: 409 });
    });

    test('given stock in two warehouses when priority warehouse is short then allocation falls through', async () => {
        const v = await makeVariant('ALLOC');
        // secondWh has priority 50 (better than MAIN's 1? no — lower is better, MAIN=1).
        // Put 1 in MAIN (priority 1) and 10 in second (priority 50): a request
        // for 5 must skip MAIN and land on the second warehouse.
        await InventoryService.receiveStock({ variantNo: v, warehouseNo: mainWh, qty: 1, unitCost: 1 }, USER_ID);
        await InventoryService.receiveStock({ variantNo: v, warehouseNo: secondWh, qty: 10, unitCost: 1 }, USER_ID);
        const { ordNo, orderLineId } = await makeOrder(v, 5);

        const reservations = await InventoryService.reserveForOrder(
            ordNo, [{ orderLineId, variantNo: v, qty: 5 }], USER_ID);

        expect(Number(reservations[0].warehouse_no)).toBe(Number(secondWh));
        expect(Number((await balance(v, secondWh)).qty_reserved)).toBe(5);
        expect(Number((await balance(v, mainWh)).qty_reserved)).toBe(0);

        // Aggregate availability reflects both warehouses minus the reservation
        const avail = await InventoryBalances.availability([v]);
        expect(avail.get(Number(v))).toBe(6);
    });
});
