'use strict';

const { DB: db, withTransaction } = require('../common/db');
const InventoryTransactions = require('../models/inventoryTransactions');
const PaymentsService       = require('./paymentsService');

/**
 * RmaService — returns workflow.
 *
 *   requested ──approve──▶ approved ──receive──▶ received ──refund──▶ refunded ──close──▶ closed
 *       └──reject──▶ rejected (terminal)
 *
 * - 'rejected' is terminal on purpose: every non-rejected RMA line counts
 *   against its order line's return budget (you cannot return more than was
 *   bought, cumulatively across RMAs), and a rejected request must hand its
 *   claim back. If it could drift into the shared 'closed' state the two
 *   would be indistinguishable.
 * - Customers open RMAs against their own shipped orders; staff (rma:manage)
 *   drive the rest of the lifecycle.
 * - Receiving with restock=true writes RET ledger rows at the line's original
 *   FIFO cost (read off the order's OUT transaction), so returned goods come
 *   back on the books at what they left for — valuation stays honest.
 * - The refund step delegates to PaymentsService.refundOrder (refunds:create,
 *   Finance) and links the refund to the RMA.
 *
 * v1 boundaries (extend when the business needs them): no return shipping
 * labels, no partial-quantity receiving per line (a line is received whole),
 * no automatic refund amount calculation — Finance enters the amount.
 */
const RmaService = (function () {

    const TRANSITIONS = {
        requested: ['approved', 'rejected'],
        approved:  ['received'],
        received:  ['refunded', 'closed'],
        refunded:  ['closed'],
        rejected:  [],
        closed:    [],
    };

    return { request, updateStatus, receive, refund, findOne, list };

    /**
     * Customer (or staff) opens an RMA for lines of a shipped order.
     *
     * @param {object} data - { ord_no, reason, lines:[{order_line_id, qty, condition?}] }
     * @param {{userId:number, staff:boolean}} actor
     */
    function request(data, { userId, staff }) {
        const { ord_no, reason, lines = [] } = data;
        if (!ord_no)        return Promise.reject(Object.assign(new Error('ord_no is required'), { status: 400 }));
        if (!reason)        return Promise.reject(Object.assign(new Error('reason is required'), { status: 400 }));
        if (!lines.length)  return Promise.reject(Object.assign(new Error('At least one line is required'), { status: 400 }));

        return withTransaction(async (client) => {
            const ownerClause = staff ? '' : 'AND c.user_id = $2';
            const params      = staff ? [ord_no] : [ord_no, userId];
            const ordRes = await client.query(
                `SELECT o.ord_no, o.status FROM orders o
                 JOIN customers c ON c.id = o._customer_id
                 WHERE o.ord_no = $1 ${ownerClause}`,
                params
            );
            const order = ordRes.rows[0];
            if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
            if (!['shipped', 'completed'].includes(order.status)) {
                throw Object.assign(new Error('Returns are only accepted for shipped orders'), { status: 409 });
            }

            const rmaRes = await client.query(
                `INSERT INTO rmas (_ord_no, reason, _create_user_id, _modify_user_id)
                 VALUES ($1, $2, $3, $3) RETURNING rma_no`,
                [ord_no, reason, userId]
            );
            const rmaNo = rmaRes.rows[0].rma_no;

            for (const ln of lines) {
                // FOR UPDATE serializes concurrent RMA requests against the
                // same order line, so the cumulative budget check below holds.
                const lineRes = await client.query(
                    `SELECT id, qty, fulfillment_status FROM order_lines
                     WHERE id = $1 AND _ord_no = $2
                     FOR UPDATE`,
                    [ln.order_line_id, ord_no]
                );
                const line = lineRes.rows[0];
                if (!line) throw Object.assign(
                    new Error(`Line ${ln.order_line_id} does not belong to order ${ord_no}`), { status: 400 });
                if (!(ln.qty > 0) || Number(ln.qty) > Number(line.qty)) {
                    throw Object.assign(
                        new Error(`Return qty for line ${ln.order_line_id} must be between 0 and ${line.qty}`),
                        { status: 400 });
                }
                // Cumulative budget: every non-rejected RMA line (including
                // lines already added in this request) counts against the
                // order line's purchased quantity.
                const prior = await client.query(
                    `SELECT COALESCE(SUM(rl.qty), 0) AS returned
                     FROM rma_lines rl
                     JOIN rmas r ON r.rma_no = rl._rma_no
                     WHERE rl._order_line_id = $1 AND r.status <> 'rejected'`,
                    [ln.order_line_id]
                );
                // Fixed-point compare (qty is NUMERIC(14,4); pg hands back
                // floats, and float sums miss exact boundaries).
                const toUnits = n => Math.round(Number(n) * 10000);
                const alreadyReturned = Number(prior.rows[0].returned);
                if (toUnits(alreadyReturned) + toUnits(ln.qty) > toUnits(line.qty)) {
                    throw Object.assign(
                        new Error(`Return qty for line ${ln.order_line_id} exceeds the remaining ` +
                                  `returnable quantity (${Number(line.qty) - alreadyReturned} of ${line.qty})`),
                        { status: 409 });
                }
                await client.query(
                    `INSERT INTO rma_lines (_rma_no, _order_line_id, qty, condition)
                     VALUES ($1, $2, $3, $4)`,
                    [rmaNo, ln.order_line_id, ln.qty, ln.condition || null]
                );
            }
            return rmaNo;
        });
    }

    /**
     * Staff transition (approve / reject / close). Guarded by the state
     * machine; the WHERE clause makes concurrent transitions race-safe.
     */
    async function updateStatus(rmaNo, toStatus, userId, notes = null) {
        const fromStatuses = Object.entries(TRANSITIONS)
            .filter(([, tos]) => tos.includes(toStatus))
            .map(([from]) => from);
        if (!fromStatuses.length) {
            throw Object.assign(new Error(`Unknown RMA status: ${toStatus}`), { status: 400 });
        }
        const res = await db.query(
            `UPDATE rmas
             SET status = $2, notes = COALESCE($4, notes), _modify_ts = NOW(), _modify_user_id = $3
             WHERE rma_no = $1 AND status = ANY($5)
             RETURNING rma_no, status`,
            [rmaNo, toStatus, userId, notes, fromStatuses]
        );
        if (!res.rows.length) {
            const cur = await db.query(`SELECT status FROM rmas WHERE rma_no = $1`, [rmaNo]);
            if (!cur.rows.length) throw Object.assign(new Error('RMA not found'), { status: 404 });
            throw Object.assign(
                new Error(`Cannot transition RMA from '${cur.rows[0].status}' to '${toStatus}'`), { status: 409 });
        }
        return res.rows[0];
    }

    /**
     * Receives the physical return. Lines with restock=true go back into
     * stock as RET ledger rows at the original sale's FIFO cost (creating a
     * new cost layer); restock=false lines are recorded but written off —
     * damaged goods never re-enter sellable inventory.
     *
     * @param {number} rmaNo
     * @param {Array<{rma_line_id:number, restock:boolean}>} dispositions
     */
    function receive(rmaNo, dispositions = [], userId) {
        return withTransaction(async (client) => {
            const rmaRes = await client.query(
                `SELECT rma_no, _ord_no, status FROM rmas WHERE rma_no = $1 FOR UPDATE`, [rmaNo]);
            const rma = rmaRes.rows[0];
            if (!rma) throw Object.assign(new Error('RMA not found'), { status: 404 });
            if (rma.status !== 'approved') {
                throw Object.assign(new Error(`Cannot receive an RMA in '${rma.status}'`), { status: 409 });
            }

            const linesRes = await client.query(
                `SELECT rl.id, rl.qty, ol.ln_no, ol._variant_no, ol._warehouse_no
                 FROM rma_lines rl
                 JOIN order_lines ol ON ol.id = rl._order_line_id
                 WHERE rl._rma_no = $1`,
                [rmaNo]
            );
            const byId = new Map(linesRes.rows.map(r => [Number(r.id), r]));
            const restocked = [];

            for (const d of dispositions) {
                const line = byId.get(Number(d.rma_line_id));
                if (!line) throw Object.assign(
                    new Error(`RMA line ${d.rma_line_id} not found on RMA ${rmaNo}`), { status: 400 });

                await client.query(
                    `UPDATE rma_lines SET restock = $2 WHERE id = $1`, [d.rma_line_id, !!d.restock]);
                if (!d.restock) continue;

                // Original FIFO cost from the sale's OUT row — the goods return
                // at the value they left with.
                const costRes = await client.query(
                    `SELECT unit_cost, _warehouse_no FROM inventory_transactions
                     WHERE _lnk_table = 'orders' AND _lnk_id = $1 AND _ln_no = $2 AND _trn_type = 'OUT'
                     ORDER BY trn_no DESC LIMIT 1`,
                    [rma._ord_no, line.ln_no]
                );
                if (!costRes.rows.length) {
                    throw Object.assign(
                        new Error(`No sale transaction found for order ${rma._ord_no} line ${line.ln_no} — cannot restock`),
                        { status: 422 });
                }
                const trn = await InventoryTransactions.create({
                    _trn_type: 'RET',
                    _variant_no: line._variant_no,
                    _warehouse_no: line._warehouse_no || costRes.rows[0]._warehouse_no,
                    qty: Number(line.qty),
                    unit_cost: Number(costRes.rows[0].unit_cost),
                    _lnk_table: 'rmas',
                    _lnk_id: rmaNo,
                    _ln_no: line.ln_no,
                }, userId, client);
                restocked.push(trn.trn_no);
            }

            await client.query(
                `UPDATE rmas SET status = 'received', _modify_ts = NOW(), _modify_user_id = $2
                 WHERE rma_no = $1`,
                [rmaNo, userId]
            );
            return { rma_no: rmaNo, status: 'received', restocked_transactions: restocked };
        });
    }

    /**
     * Finance refunds a received RMA. Delegates to the payments refund flow
     * and links the refund to this RMA.
     */
    async function refund(rmaNo, amount, reason, userId) {
        const rmaRes = await db.query(`SELECT _ord_no, status FROM rmas WHERE rma_no = $1`, [rmaNo]);
        const rma = rmaRes.rows[0];
        if (!rma) throw Object.assign(new Error('RMA not found'), { status: 404 });
        if (rma.status !== 'received') {
            throw Object.assign(new Error('Only received RMAs can be refunded'), { status: 409 });
        }

        const result = await PaymentsService.refundOrder(rma._ord_no, amount, reason, userId);
        await db.query(`UPDATE refunds SET _rma_no = $2 WHERE refund_no = $1`, [result.refund_no, rmaNo]);
        await db.query(
            `UPDATE rmas SET status = 'refunded', _modify_ts = NOW(), _modify_user_id = $2
             WHERE rma_no = $1 AND status = 'received'`,
            [rmaNo, userId]
        );
        return { ...result, rma_no: rmaNo };
    }

    function findOne(rmaNo, { userId = null, staff = false } = {}) {
        const ownerClause = staff ? '' : 'AND c.user_id = $2';
        const params      = staff ? [rmaNo] : [rmaNo, userId];
        return Promise.all([
            db.query(
                `SELECT r.*, o.email AS order_email, c.name AS customer_name
                 FROM rmas r
                 JOIN orders o    ON o.ord_no = r._ord_no
                 JOIN customers c ON c.id = o._customer_id
                 WHERE r.rma_no = $1 ${ownerClause}`,
                params
            ).then(res => res.rows[0] || null),
            db.query(
                `SELECT rl.id, rl.qty, rl.condition, rl.restock,
                        ol.ln_no, ol.sku, ol.descr, ol.unit_price
                 FROM rma_lines rl
                 JOIN order_lines ol ON ol.id = rl._order_line_id
                 WHERE rl._rma_no = $1
                 ORDER BY ol.ln_no`,
                [rmaNo]
            ).then(res => res.rows),
        ]).then(([rma, lines]) => rma ? { ...rma, lines } : null);
    }

    function list({ status = null, userId = null, staff = false, limit = 25, offset = 0 } = {}) {
        const params  = [];
        const clauses = [];
        if (!staff) { params.push(userId); clauses.push(`c.user_id = $${params.length}`); }
        if (status)  { params.push(status); clauses.push(`r.status = $${params.length}`); }
        const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
        params.push(offset, limit);
        return db.query(
            `SELECT r.rma_no, r._ord_no, r.status, r.reason, r._create_ts,
                    c.name AS customer_name,
                    COUNT(rl.id)::int AS line_count,
                    COUNT(*) OVER()::int AS _total
             FROM rmas r
             JOIN orders o    ON o.ord_no = r._ord_no
             JOIN customers c ON c.id = o._customer_id
             LEFT JOIN rma_lines rl ON rl._rma_no = r.rma_no
             ${where}
             GROUP BY r.rma_no, c.name
             ORDER BY r._create_ts DESC
             OFFSET $${params.length - 1} LIMIT $${params.length}`,
            params
        ).then(res => ({
            rows: res.rows.map(({ _total, ...r }) => r),
            total: res.rows.length ? res.rows[0]._total : 0,
        }));
    }

}());

module.exports = RmaService;
