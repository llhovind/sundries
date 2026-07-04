'use strict';

const express           = require('express');
const router            = express.Router();
const requirePermission = require('../middleware/requirePermission');
const { DB: db }        = require('../common/db');
const InventoryBalances     = require('../models/inventoryBalances');
const InventoryTransactions = require('../models/inventoryTransactions');
const InventoryService      = require('../services/inventoryService');
const Pagination            = require('../common/pagination');

// GET /api/v1/inventory/balances?q=&page=&pageSize= — per-variant totals with
// per-warehouse breakdown (inventory:read)
router.get('/balances', requirePermission('inventory:read'), async (req, res, next) => {
    try {
        const { page, pageSize, offset } = Pagination.parsePageQuery(req.query);
        const params = [];
        let where = '';
        if (req.query.q) {
            params.push('%' + req.query.q + '%');
            where = `WHERE (p.name ILIKE $1 OR v.sku ILIKE $1)`;
        }
        params.push(offset, pageSize);
        const result = await db.query(
            `SELECT v.variant_no, v.sku, p.name AS product_name, p.base_uom,
                    COALESCE(SUM(b.qty_on_hand), 0)                  AS qty_on_hand,
                    COALESCE(SUM(b.qty_reserved), 0)                 AS qty_reserved,
                    COALESCE(SUM(b.qty_on_hand - b.qty_reserved), 0) AS qty_available,
                    COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
                        'warehouse_no', w.warehouse_no, 'code', w.code, 'wh_type', w.wh_type,
                        'qty_on_hand', b.qty_on_hand, 'qty_reserved', b.qty_reserved)
                        ORDER BY w.priority)
                        FILTER (WHERE b._warehouse_no IS NOT NULL), '[]') AS warehouses,
                    COUNT(*) OVER()::int AS _total
             FROM product_variants v
             JOIN products p ON p.product_no = v._product_no
             LEFT JOIN inventory_balances b ON b._variant_no = v.variant_no
             LEFT JOIN warehouses w         ON w.warehouse_no = b._warehouse_no
             ${where}
             GROUP BY v.variant_no, v.sku, p.name, p.base_uom
             ORDER BY p.name, v.sku
             OFFSET $${params.length - 1} LIMIT $${params.length}`,
            params
        );
        const total = result.rows.length ? result.rows[0]._total : 0;
        res.locals.results = Pagination.pageResult(
            'balances', result.rows.map(({ _total, ...r }) => r), total, page, pageSize);
        res.locals.status  = 200;
        res.locals.message = 'Balances returned';
        next();
    } catch (err) {
        next({ status: 500, message: 'Failed to load balances' });
    }
});

// GET /api/v1/inventory/ledger/:variant_no — transaction history (inventory:read)
router.get('/ledger/:variant_no', requirePermission('inventory:read'), (req, res, next) => {
    const variantNo = parseInt(req.params.variant_no, 10);
    if (isNaN(variantNo)) return next({ status: 400, message: 'Invalid variant_no' });
    InventoryTransactions.findForVariant(variantNo, {
        limit: Math.min(parseInt(req.query.pageSize, 10) || 50, 200),
        offset: parseInt(req.query.offset, 10) || 0,
    })
        .then(rows => {
            res.locals.results = { transactions: rows };
            res.locals.status  = 200;
            res.locals.message = 'Ledger returned';
            next();
        })
        .catch(() => next({ status: 500, message: 'Failed to load ledger' }));
});

// GET /api/v1/inventory/warehouses — pick-list for receive/adjust forms
router.get('/warehouses', requirePermission('inventory:read'), (req, res, next) => {
    db.query(`SELECT warehouse_no, code, name, wh_type, priority FROM warehouses
              WHERE status = 'active' ORDER BY priority, warehouse_no`)
        .then(r => {
            res.locals.results = { warehouses: r.rows };
            res.locals.status  = 200;
            res.locals.message = 'Warehouses returned';
            next();
        })
        .catch(() => next({ status: 500, message: 'Failed to load warehouses' }));
});

// POST /api/v1/inventory/receive — stock in with cost (inventory:receive)
router.post('/receive', requirePermission('inventory:receive'), (req, res, next) => {
    const { variant_no, warehouse_no, qty, unit_cost, notes } = req.body || {};
    InventoryService.receiveStock({
        variantNo: variant_no, warehouseNo: warehouse_no,
        qty: Number(qty), unitCost: Number(unit_cost), notes,
    }, req.user.id)
        .then(trn => {
            res.locals.results = { trn_no: trn.trn_no };
            res.locals.status  = 201;
            res.locals.message = 'Stock received';
            next();
        })
        .catch(err => next({ status: err.status || 400, message: err.message }));
});

// POST /api/v1/inventory/adjust — signed correction / write-off (inventory:adjust)
router.post('/adjust', requirePermission('inventory:adjust'), (req, res, next) => {
    const { variant_no, warehouse_no, qty, unit_cost, reason_code, notes } = req.body || {};
    InventoryService.adjust({
        variantNo: variant_no, warehouseNo: warehouse_no,
        qty: Number(qty), unitCost: unit_cost != null ? Number(unit_cost) : null,
        reasonCode: reason_code || 'count', notes,
    }, req.user.id)
        .then(trn => {
            res.locals.results = { trn_no: trn.trn_no, unit_cost: trn.unit_cost };
            res.locals.status  = 201;
            res.locals.message = 'Adjustment recorded';
            next();
        })
        .catch(err => next({ status: err.status || 400, message: err.message }));
});

module.exports = router;
