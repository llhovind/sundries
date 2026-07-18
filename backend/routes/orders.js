'use strict';

const express           = require('express');
const router            = express.Router();
const { guard }         = require('../config/routePermissions');
const OrdersCntlr       = require('../controllers/OrdersCntlr')();

// Reads: customers see their own orders, staff (orders:read) see all —
// scoping happens in the controller.
router.get('/',              OrdersCntlr.list);
router.get('/:ord_no',       OrdersCntlr.findOne);

// Fulfillment: captures the authorized payment (capture-on-fulfillment)
router.post('/:ord_no/ship', guard('POST /api/v1/orders/:ord_no/ship'), OrdersCntlr.ship);
router.put('/:ord_no/shipments/:shipment_no',
    guard('PUT /api/v1/orders/:ord_no/shipments/:shipment_no'), OrdersCntlr.updateShipment);

module.exports = router;
