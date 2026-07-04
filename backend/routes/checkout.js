'use strict';

const express       = require('express');
const router        = express.Router();
const CheckoutCntlr = require('../controllers/CheckoutCntlr')();

// Authenticated checkout (guest checkout is mounted separately, unauthenticated)
router.post('/',                CheckoutCntlr.place);
router.post('/:ord_no/cancel',  CheckoutCntlr.cancel);

module.exports = router;
