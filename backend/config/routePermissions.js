'use strict';

const requirePermission = require('../middleware/requirePermission');

/**
 * Single source of truth mapping API endpoints to the permission codes that
 * guard them. Route files never use ad-hoc permission strings — they call
 * guard('<METHOD> <path>'), which looks the codes up here and fails at
 * startup if the entry is missing.
 *
 * This is deliberately code, not data: there is no UI or API to change the
 * endpoint→permission mapping at runtime. Changing it requires a code change,
 * review, and deploy. validateRouteGuards() asserts at startup that every
 * /api/v1 route is either listed here or explicitly allow-listed below, so
 * the file cannot silently drift from the real router.
 *
 * Keys are 'METHOD <full path as registered in Express>' (param names
 * included). A route listing several codes allows callers holding ANY one.
 */
const ROUTE_PERMS = Object.freeze({
    // ── Catalog ──────────────────────────────────────────────────────────
    'POST /api/v1/products':                       ['catalog:write'],
    'PUT /api/v1/products/:product_no':            ['catalog:write'],
    'POST /api/v1/products/:product_no/variants':  ['catalog:write'],
    'PUT /api/v1/products/:product_no/options':    ['catalog:write'],
    'POST /api/v1/categories':                     ['catalog:write'],
    'PUT /api/v1/categories/:id':                  ['catalog:write'],
    'DELETE /api/v1/categories/:id':               ['catalog:write'],

    // ── Promotions ───────────────────────────────────────────────────────
    'GET /api/v1/promotions':                      ['promotions:manage'],
    'POST /api/v1/promotions':                     ['promotions:manage'],
    'PUT /api/v1/promotions/:promo_no':            ['promotions:manage'],

    // ── Inventory ────────────────────────────────────────────────────────
    'GET /api/v1/inventory/balances':              ['inventory:read'],
    'GET /api/v1/inventory/ledger/:variant_no':    ['inventory:read'],
    'GET /api/v1/inventory/warehouses':            ['inventory:read'],
    'POST /api/v1/inventory/receive':              ['inventory:receive'],
    'POST /api/v1/inventory/adjust':               ['inventory:adjust'],

    // ── Stock transfers (mounted under /inventory/transfers) ─────────────
    'GET /api/v1/inventory/transfers':                            ['inventory:read'],
    'GET /api/v1/inventory/transfers/:transfer_no':               ['inventory:read'],
    'POST /api/v1/inventory/transfers':                           ['inventory:transfer'],
    'POST /api/v1/inventory/transfers/:transfer_no/dispatch':     ['inventory:transfer'],
    'POST /api/v1/inventory/transfers/:transfer_no/receive':      ['inventory:transfer'],
    'POST /api/v1/inventory/transfers/:transfer_no/cancel':       ['inventory:transfer'],

    // ── Purchasing ───────────────────────────────────────────────────────
    'GET /api/v1/purchase-orders':                 ['purchasing:manage', 'inventory:read'],
    'GET /api/v1/purchase-orders/:po_no':          ['purchasing:manage', 'inventory:read'],
    'POST /api/v1/purchase-orders':                ['purchasing:manage'],
    'POST /api/v1/purchase-orders/:po_no/close':   ['purchasing:manage'],
    'POST /api/v1/purchase-orders/:po_no/cancel':  ['purchasing:manage'],
    'POST /api/v1/purchase-orders/:po_no/receive': ['inventory:receive'],
    'GET /api/v1/vendors':                         ['purchasing:manage', 'inventory:read'],
    'GET /api/v1/vendors/:id':                     ['purchasing:manage', 'inventory:read'],
    'POST /api/v1/vendors':                        ['purchasing:manage'],
    'PUT /api/v1/vendors/:id':                     ['purchasing:manage'],

    // ── Customers & compliance ───────────────────────────────────────────
    'GET /api/v1/customers':                       ['customers:read'],
    'GET /api/v1/customers/:id':                   ['customers:read'],
    'POST /api/v1/customers':                      ['customers:write'],
    'PUT /api/v1/customers/:id':                   ['customers:write'],
    'GET /api/v1/compliance/requests':             ['customers:write'],

    // ── Orders, payments, returns ────────────────────────────────────────
    'POST /api/v1/orders/:ord_no/ship':            ['orders:fulfill'],
    'POST /api/v1/payments/:ord_no/refund':        ['refunds:create'],
    'PUT /api/v1/rmas/:rma_no/status':             ['rma:manage'],
    'POST /api/v1/rmas/:rma_no/receive':           ['rma:manage'],
    'POST /api/v1/rmas/:rma_no/refund':            ['refunds:create'],

    // ── Reports ──────────────────────────────────────────────────────────
    'GET /api/v1/reports/cogs':                    ['reports:cogs'],
    'GET /api/v1/reports/valuation':               ['reports:cogs'],
    'GET /api/v1/reports/shrinkage':               ['reports:cogs'],
    'GET /api/v1/reports/reservations':            ['reports:view'],
    'GET /api/v1/reports/sales-summary':           ['reports:view'],

    // ── User administration ──────────────────────────────────────────────
    'GET /api/v1/users':                           ['users:manage'],
    'GET /api/v1/users/:id':                       ['users:manage'],
    'GET /api/v1/users/roles':                     ['users:manage'],
    'POST /api/v1/users':                          ['users:manage'],
    'PUT /api/v1/users/:id':                       ['users:manage'],
    'DELETE /api/v1/users/:id':                    ['users:manage'],
    'POST /api/v1/users/:id/roles':                ['users:manage'],
    'DELETE /api/v1/users/:id/roles/:role':        ['users:manage'],

    // ── Store configuration (settings, shipping, tax, warehouses) ────────
    'GET /api/v1/settings/values':                   ['settings:manage'],
    'PUT /api/v1/settings/values/:key':              ['settings:manage'],
    'GET /api/v1/settings/shipping-rules':           ['settings:manage'],
    'POST /api/v1/settings/shipping-rules':          ['settings:manage'],
    'PUT /api/v1/settings/shipping-rules/:rule_no':  ['settings:manage'],
    'GET /api/v1/settings/weight-bands':             ['settings:manage'],
    'POST /api/v1/settings/weight-bands':            ['settings:manage'],
    'PUT /api/v1/settings/weight-bands/:band_no':    ['settings:manage'],
    'GET /api/v1/settings/tax-rates':                ['settings:manage'],
    'POST /api/v1/settings/tax-rates':               ['settings:manage'],
    'PUT /api/v1/settings/tax-rates/:rate_no':       ['settings:manage'],
    'GET /api/v1/settings/warehouses':               ['settings:manage'],
    'POST /api/v1/settings/warehouses':              ['settings:manage'],
    'PUT /api/v1/settings/warehouses/:warehouse_no': ['settings:manage'],

    // ── Role administration (escalation-sensitive — admin only) ──────────
    'GET /api/v1/roles':                           ['roles:manage'],
    'GET /api/v1/roles/permissions':               ['roles:manage'],
    'POST /api/v1/roles':                          ['roles:manage'],
    'PUT /api/v1/roles/:code':                     ['roles:manage'],
    'PUT /api/v1/roles/:code/permissions':         ['roles:manage'],
    'DELETE /api/v1/roles/:code':                  ['roles:manage'],
});

/**
 * /api/v1 routes that intentionally carry NO permission guard: anonymous
 * storefront endpoints, auth flows, and session-scoped resources whose
 * ownership checks live in the handler (a customer only ever sees their own
 * orders/cart/RMAs). Every entry is a conscious decision — a new route that
 * appears in neither list fails startup validation.
 */
const UNGUARDED_ROUTES = Object.freeze([
    // Auth flows (anonymous by nature)
    'POST /api/v1/auth/register',
    'POST /api/v1/auth/request-otp',
    'POST /api/v1/auth/verify-otp',
    'POST /api/v1/auth/refresh',
    'POST /api/v1/auth/logout',

    // Public storefront reads (anonymous guests browse)
    'GET /api/v1/products',
    'GET /api/v1/products/:product_no',
    'GET /api/v1/categories',
    'GET /api/v1/categories/:id',
    'GET /api/v1/search/products',
    'POST /api/v1/promotions/validate',

    // Session-scoped: cart & checkout (guest or owner)
    'GET /api/v1/cart',
    'POST /api/v1/cart/items',
    'PUT /api/v1/cart/items/:variant_no',
    'DELETE /api/v1/cart/items/:variant_no',
    'POST /api/v1/checkout',
    'POST /api/v1/checkout/:ord_no/cancel',
    'POST /api/v1/checkout/guest',

    // Owner-scoped reads/writes (controller enforces ownership; staff scope
    // inside the handler via orders:read / rma:manage)
    'GET /api/v1/orders',
    'GET /api/v1/orders/:ord_no',
    'GET /api/v1/rmas',
    'GET /api/v1/rmas/:rma_no',
    'POST /api/v1/rmas',
    'GET /api/v1/customers/me',
    'PUT /api/v1/customers/me',
    'ALL /api/v1/customers/me',        // router.all exit-guard so /:id never matches /me
    'POST /api/v1/compliance/requests',

    // Payment provider surface (webhook is signature-verified, fake is local demo)
    'POST /api/v1/payments/webhook/:provider',
    'POST /api/v1/payments/fake/confirm',
]);

/**
 * Route guard factory backed by ROUTE_PERMS.
 * Throws at require time (i.e. at startup) when the endpoint is not mapped,
 * so an unmapped route can never reach production silently.
 *
 * Usage: router.post('/', guard('POST /api/v1/products'), handler)
 */
function guard(endpointKey) {
    const codes = ROUTE_PERMS[endpointKey];
    if (!codes) {
        throw new Error(
            `No permission mapping for "${endpointKey}" — add it to config/routePermissions.js`
        );
    }
    return requirePermission(...codes);
}

module.exports = { ROUTE_PERMS, UNGUARDED_ROUTES, guard };
