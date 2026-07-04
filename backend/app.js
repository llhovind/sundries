require('./common/config');   // validates required env vars — throws at startup if any are missing
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const multer = require('multer');
const responseHandler = require('./common/responseHandlers');
const auth = require('./middleware/auth');

var app = express();

app.use(logger('combined'));

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

// Protected routes
app.use('/api/v1/products',       auth, require('./routes/products'));
app.use('/api/v1/inventory',      auth, require('./routes/inventory'));
app.use('/api/v1/categories',     auth, require('./routes/categories'));
app.use('/api/v1/vendors',        auth, require('./routes/vendors'));
app.use('/api/v1/customers',      auth, require('./routes/customers'));
app.use('/api/v1/users',          auth, require('./routes/users'));
app.use('/api/v1/cart',           auth, require('./routes/carts'));
app.use('/api/v1/checkout',       auth, require('./routes/checkout'));
app.use('/api/v1/search',         auth, require('./routes/search'));
app.use('/api/v1/reports',        auth, require('./routes/reports'));
app.use('/api/v1/promotions',     auth, require('./routes/promotions'));
app.use('/api/v1/rmas',           auth, require('./routes/rmas'));
app.use('/api/v1/compliance',     auth, require('./routes/compliance'));
app.use('/api/v1/orders',         auth, require('./routes/orders'));
app.use('/api/v1/payments',       auth, require('./routes/payments'));

app.use(responseHandler.handleResponse);
app.use(responseHandler.handleErrorResponse);

// Multer errors that escape controller-level handling (e.g. middleware chain edge cases)
app.use((err, _req, res, next) => {
    if (err instanceof multer.MulterError || err.status === 400) {
        return res.status(400).json({ outcome: { statusCode: 400, message: err.message } });
    }
    next(err);
});

module.exports = app;
