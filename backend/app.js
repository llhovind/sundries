const config = require('./common/config');   // validates required env vars — throws at startup if any are missing
var express = require('express');
var helmet = require('helmet');
var cookieParser = require('cookie-parser');
var morgan = require('morgan');
const Logger = require('./common/logger');
const responseHandler = require('./common/responseHandlers');
const auth = require('./middleware/auth');
const optionalAuth = require('./middleware/optionalAuth');
const { mountImageDelivery } = require('./middleware/imageDelivery');

var app = express();

// Public URL prefix for catalog images. The frontend builds every image src as
// `${IMAGE_PATH}/${primary_image}`, so this is the one place it is defined and
// the seam a CDN can take over (see mountImageDelivery below).
const IMAGE_PATH = '/images';

// Behind a reverse proxy in every documented deployment tier (see README):
// derive req.ip / req.protocol from X-Forwarded-* per TRUST_PROXY, so the ip
// on every log line and audit row is the real client, not the proxy. Must be
// set before any middleware reads req.ip.
app.set('trust proxy', config.trustProxy);

// Security response headers on every response — set first so even early-exiting
// routes (webhooks, static images) are covered, and strip the default
// `X-Powered-By: Express` fingerprint. Helmet's defaults suit this deployment:
// nginx serves the SPA document and proxies /api + /images from the SAME origin
// (the frontend uses relative URLs — see frontend/src/services/api.js and the
// /images references), so the default same-origin CSP and Cross-Origin-Resource-
// Policy never block the storefront. Revisit these two if the frontend is ever
// served from a different origin than the API.
app.use(helmet());

// Per-request context (correlation id + client ip) — must be first so every
// log line and DB audit row downstream can attribute itself to the request.
app.use(require('./common/requestContext').middleware);

// HTTP access log — same structured JSON envelope as every other log line
// (common/logger renders it; morgan owns the response-finished hook).
app.use(morgan((tokens, req, res) => Logger.format('info', 'http access', {
    method:         tokens.method(req, res),
    path:           tokens.url(req, res),
    status:         Number(tokens.status(req, res)) || null,
    contentLength:  Number(tokens.res(req, res, 'content-length')) || 0,
    responseTimeMs: Number(tokens['response-time'](req, res)) || null,
})));

// Payment webhooks need the RAW request body for signature verification, so
// this router mounts BEFORE the JSON body parser.
app.use('/api/v1/payments/webhook', require('./routes/paymentsWebhook'));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Public image delivery at /images/<product_no>/<filename>. WHERE those bytes
// come from is the image store's business (services/images), not this file's —
// it hands back a delivery descriptor and the app layer mounts it.
mountImageDelivery(app, IMAGE_PATH, require('./services/images').publicDelivery());

// Public routes
app.use('/', require('./routes/index'));
app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/checkout/guest', require('./routes/checkoutGuest'));
app.use('/api/v1/payments/fake',  require('./routes/paymentsFake'));   // local demo only

// Storefront routes — anonymous browsing allowed; writes inside each router
// are gated by requirePermission, which rejects anonymous callers.
app.use('/api/v1/products',       optionalAuth, require('./routes/products'));
app.use('/api/v1/categories',     optionalAuth, require('./routes/categories'));
app.use('/api/v1/search',         optionalAuth, require('./routes/search'));
app.use('/api/v1/promotions',     optionalAuth, require('./routes/promotions'));

// Protected routes
app.use('/api/v1/inventory',      auth, require('./routes/inventory'));
app.use('/api/v1/purchase-orders', auth, require('./routes/purchaseOrders'));
app.use('/api/v1/vendors',        auth, require('./routes/vendors'));
app.use('/api/v1/customers',      auth, require('./routes/customers'));
app.use('/api/v1/users',          auth, require('./routes/users'));
app.use('/api/v1/roles',          auth, require('./routes/roles'));
app.use('/api/v1/settings',       auth, require('./routes/settings'));
app.use('/api/v1/audit-log',      auth, require('./routes/auditLog'));
app.use('/api/v1/cart',           auth, require('./routes/carts'));
app.use('/api/v1/checkout',       auth, require('./routes/checkout'));
app.use('/api/v1/reports',        auth, require('./routes/reports'));
app.use('/api/v1/rmas',           auth, require('./routes/rmas'));
app.use('/api/v1/compliance',     auth, require('./routes/compliance'));
app.use('/api/v1/orders',         auth, require('./routes/orders'));
app.use('/api/v1/payments',       auth, require('./routes/payments'));

// Fail fast: every /api/v1 route must match config/routePermissions.js
// (guarded with exactly the configured codes, or explicitly allow-listed).
require('./config/validateRouteGuards').validateRouteGuards(app);

app.use(responseHandler.handleResponse);
app.use(responseHandler.handleErrorResponse);

module.exports = app;
