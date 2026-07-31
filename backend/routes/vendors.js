'use strict';

const { createApiRouter } = require('../common/apiRouter');
const router            = createApiRouter('/api/v1/vendors');
const { guard }         = require('../config/routePermissions');
const VendorsCntlr      = require('../controllers/VendorsCntlr')();

// Vendors are staff data — previously readable by any authenticated user,
// now gated: purchasing owns vendors; inventory staff can look them up.
router.get('/',    guard('GET /api/v1/vendors'),     VendorsCntlr.find);
router.get('/:id', guard('GET /api/v1/vendors/:id'), VendorsCntlr.findOne);
router.post('/',   guard('POST /api/v1/vendors'),    VendorsCntlr.create);
router.put('/:id', guard('PUT /api/v1/vendors/:id'), VendorsCntlr.update);

module.exports = router;
