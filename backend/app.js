require('./common/config');   // validates required env vars — throws at startup if any are missing
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var morgan = require('morgan');
const Logger = require('./common/logger');
const responseHandler = require('./common/responseHandlers');
const auth = require('./middleware/auth');
const optionalAuth = require('./middleware/optionalAuth');

var app = express();

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

// Static image serving — uploads/:item_no/:filename exposed at /images/:item_no/:filename
app.use('/images', express.static(path.join(__dirname, 'uploads')));

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
