'use strict';

const { createApiRouter } = require('../common/apiRouter');
const router            = createApiRouter('/api/v1/customers');
const { guard }         = require('../config/routePermissions');
const CustomersCntlr    = require('../controllers/CustomersCntlr')();

// Self-service: any authenticated user manages their own profile
router.get('/me',  CustomersCntlr.getMe);
router.put('/me',  CustomersCntlr.upsertMe);
// After any /me handler calls next(), exit this router so /:id never matches /me
router.all('/me',  (_req, _res, next) => next('router'));

// Staff access to customer accounts
router.get('/',    guard('GET /api/v1/customers'),     CustomersCntlr.find);
router.get('/:id', guard('GET /api/v1/customers/:id'), CustomersCntlr.findOne);
router.post('/',   guard('POST /api/v1/customers'),     CustomersCntlr.create);
router.put('/:id', guard('PUT /api/v1/customers/:id'),  CustomersCntlr.update);

module.exports = router;
