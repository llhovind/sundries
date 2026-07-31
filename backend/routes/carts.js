'use strict';

const { createApiRouter } = require('../common/apiRouter');
const router       = createApiRouter('/api/v1/cart');
const CartsCntlr   = require('../controllers/CartsCntlr')();

router.get('/',                     CartsCntlr.getCart);
router.post('/items',               CartsCntlr.addItem);
router.put('/items/:variant_no',    CartsCntlr.updateItem);
router.delete('/items/:variant_no', CartsCntlr.removeItem);

module.exports = router;
