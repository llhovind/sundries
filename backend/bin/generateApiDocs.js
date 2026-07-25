'use strict';

/**
 * generateApiDocs.js — regenerates docs/API.md from the route→permission map.
 *
 * The endpoint reference is derived, never hand-maintained: it reads the exact
 * same ROUTE_PERMS / UNGUARDED_ROUTES structures that config/validateRouteGuards.js
 * asserts against the live Express router at every boot. Two properties follow:
 *
 *   1. Completeness — startup validation already fails the process unless every
 *      /api/v1 route appears in one of those two maps, so this document cannot
 *      omit a real endpoint or list one that no longer exists.
 *   2. Accuracy of the Auth column — the permission codes shown are the codes
 *      the guard actually enforces, not a second copy that could disagree.
 *
 * The one piece of knowledge not present in machine-readable form is *why* an
 * unguarded route is unguarded (anonymous vs. owner-scoped). That lives in
 * UNGUARDED_AUTH below, and the script throws if any allow-listed route is left
 * unclassified — the same "fail loudly on drift" stance as the route guards.
 *
 * Usage: npm run docs:api   (writes ../docs/API.md, repo-root relative)
 * CI could run this with --check to fail when the committed file is stale.
 */

const fs   = require('fs');
const path = require('path');
const { ROUTE_PERMS, UNGUARDED_ROUTES } = require('../config/routePermissions');

const OUTPUT_PATH = path.join(__dirname, '..', '..', 'docs', 'API.md');

/**
 * Why each allow-listed route needs no permission guard. Keyed by the exact
 * route string so a new UNGUARDED_ROUTES entry that is not described here fails
 * generation rather than silently rendering a blank Auth cell.
 */
const UNGUARDED_AUTH = Object.freeze({
    anonymous: 'Public',              // no session required at all
    session:   'Session',             // any signed-in user (guest or member)
    owner:     'Session · owner',     // signed-in; handler scopes to the caller's own rows
    provider:  'Provider callback',   // authenticated out-of-band (webhook signature / local demo)
});

/** Classifier: exact route string → UNGUARDED_AUTH key. */
const UNGUARDED_CLASSIFICATION = Object.freeze({
    'POST /api/v1/auth/register':                 'anonymous',
    'POST /api/v1/auth/request-otp':              'anonymous',
    'POST /api/v1/auth/verify-otp':               'anonymous',
    'POST /api/v1/auth/refresh':                  'anonymous',
    'POST /api/v1/auth/logout':                   'anonymous',
    'GET /api/v1/products':                       'anonymous',
    'GET /api/v1/products/:product_no':           'anonymous',
    'GET /api/v1/categories':                     'anonymous',
    'GET /api/v1/categories/:id':                 'anonymous',
    'GET /api/v1/search/products':                'anonymous',
    'POST /api/v1/promotions/validate':           'anonymous',
    'GET /api/v1/cart':                           'session',
    'POST /api/v1/cart/items':                    'session',
    'PUT /api/v1/cart/items/:variant_no':         'session',
    'DELETE /api/v1/cart/items/:variant_no':      'session',
    'POST /api/v1/checkout':                      'session',
    'POST /api/v1/checkout/:ord_no/cancel':       'owner',
    'POST /api/v1/checkout/guest':                'anonymous',
    'GET /api/v1/orders':                         'owner',
    'GET /api/v1/orders/:ord_no':                 'owner',
    'GET /api/v1/rmas':                           'owner',
    'GET /api/v1/rmas/:rma_no':                   'owner',
    'POST /api/v1/rmas':                          'owner',
    'GET /api/v1/customers/me':                   'owner',
    'PUT /api/v1/customers/me':                   'owner',
    'ALL /api/v1/customers/me':                   'owner',
    'POST /api/v1/compliance/requests':           'owner',
    'POST /api/v1/payments/webhook/:provider':    'provider',
    'POST /api/v1/payments/fake/confirm':         'provider',
});

/**
 * Section a route belongs to, by its first path segment after /api/v1/.
 * Order here is the order sections appear in the document.
 */
const SECTIONS = [
    { title: 'Authentication',         segments: ['auth'] },
    { title: 'Catalog & storefront',   segments: ['products', 'categories', 'search', 'promotions'] },
    { title: 'Cart & checkout',        segments: ['cart', 'checkout'] },
    { title: 'Orders, payments & returns', segments: ['orders', 'payments', 'rmas'] },
    { title: 'Inventory',              segments: ['inventory'] },
    { title: 'Purchasing',             segments: ['purchase-orders', 'vendors'] },
    { title: 'Customers & compliance', segments: ['customers', 'compliance'] },
    { title: 'Reports',                segments: ['reports'] },
    { title: 'Administration',         segments: ['users', 'roles', 'settings', 'audit-log'] },
];

const API_PREFIX = '/api/v1/';

/** '<METHOD> <path>' → the path's first segment after the API prefix. */
function firstSegment(routeKey) {
    const spacePath = routeKey.slice(routeKey.indexOf(' ') + 1);
    return spacePath.slice(API_PREFIX.length).split('/')[0];
}

function splitRoute(routeKey) {
    const idx = routeKey.indexOf(' ');
    return { method: routeKey.slice(0, idx), routePath: routeKey.slice(idx + 1) };
}

/** Human-readable Auth cell for one route. */
function authLabel(routeKey) {
    const codes = ROUTE_PERMS[routeKey];
    if (codes) {
        // A route listing several codes grants access to holders of ANY one.
        return codes.map(c => `\`${c}\``).join(' or ');
    }
    const classification = UNGUARDED_CLASSIFICATION[routeKey];
    if (!classification) {
        throw new Error(
            `Unclassified unguarded route: "${routeKey}". Add it to UNGUARDED_CLASSIFICATION ` +
            `in bin/generateApiDocs.js (its Auth column would otherwise be blank).`);
    }
    return UNGUARDED_AUTH[classification];
}

/** Every /api/v1 route the app knows about, guarded and unguarded alike. */
function allRoutes() {
    const guarded   = Object.keys(ROUTE_PERMS);
    const unguarded = [...UNGUARDED_ROUTES];

    // Fail loudly if the allow-list grew a route we do not describe.
    for (const routeKey of unguarded) authLabel(routeKey);

    return [...guarded, ...unguarded];
}

function sortRoutes(a, b) {
    const pa = splitRoute(a), pb = splitRoute(b);
    return pa.routePath.localeCompare(pb.routePath) || pa.method.localeCompare(pb.method);
}

function renderSection(title, routeKeys) {
    const lines = [
        `### ${title}`,
        '',
        '| Method | Path | Auth |',
        '|---|---|---|',
    ];
    for (const routeKey of routeKeys.sort(sortRoutes)) {
        const { method, routePath } = splitRoute(routeKey);
        lines.push(`| ${method} | \`${routePath}\` | ${authLabel(routeKey)} |`);
    }
    lines.push('');
    return lines.join('\n');
}

function render() {
    const routes = allRoutes();
    const bySegment = new Map();
    for (const routeKey of routes) {
        const seg = firstSegment(routeKey);
        if (!bySegment.has(seg)) bySegment.set(seg, []);
        bySegment.get(seg).push(routeKey);
    }

    // Guard against a new resource segment that no section claims.
    const claimed = new Set(SECTIONS.flatMap(s => s.segments));
    const orphans = [...bySegment.keys()].filter(seg => !claimed.has(seg));
    if (orphans.length) {
        throw new Error(
            `Route segment(s) not assigned to any doc section: ${orphans.join(', ')}. ` +
            `Add them to SECTIONS in bin/generateApiDocs.js.`);
    }

    const body = SECTIONS
        .map(({ title, segments }) => {
            const keys = segments.flatMap(seg => bySegment.get(seg) ?? []);
            return keys.length ? renderSection(title, keys) : null;
        })
        .filter(Boolean)
        .join('\n');

    return `${HEADER}\n${body}`;
}

const HEADER = `# API reference

**Do not edit this file by hand.** It is generated from
\`backend/config/routePermissions.js\` by \`npm run docs:api\`. Because the app
validates that same map against the live router at every boot
(\`config/validateRouteGuards.js\`), this reference lists exactly the routes the
server actually serves — no more, no less — with the permission codes their
guards actually enforce.

## Conventions

- **Base URL**: all paths below are under \`/api/v1\` (shown in full).
- **Versioning**: the version is in the path (\`/api/v1\`); a breaking change
  ships as \`/api/v2\` beside it.
- **Auth transport**: send the access token as \`Authorization: Bearer <token>\`.
  Obtain it from \`POST /api/v1/auth/verify-otp\` (passwordless OTP) — the same
  call sets an httpOnly, rotating \`refresh_token\` cookie scoped to
  \`/api/v1/auth\`; exchange it at \`POST /api/v1/auth/refresh\`. Reuse of a
  retired refresh token revokes the whole token family.
- **Auth column**:
  - a permission code (e.g. \`catalog:write\`) — the caller's token must carry
    it; several codes joined by *or* means **any one** suffices.
  - **Public** — no session required.
  - **Session** — any signed-in user (guest or member).
  - **Session · owner** — signed-in, and the handler scopes the response to the
    caller's own rows (staff with the relevant read permission see more).
  - **Provider callback** — authenticated out-of-band (webhook signature, or the
    local fake-payment demo); not called by first-party clients.
- **Response envelope**: every response is
  \`{ path, outcome: { statusCode, message, errors?, warnings?, failures? }, content? }\`.
  On success the payload is under \`content\`; \`outcome.failures\` carries
  machine-readable per-item detail (e.g. per-line checkout reservation failures).

`;

function main() {
    const markdown = render();
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, markdown);
    const count = allRoutes().length;
    console.log(`Wrote ${path.relative(path.join(__dirname, '..', '..'), OUTPUT_PATH)} (${count} endpoints).`);
}

main();
