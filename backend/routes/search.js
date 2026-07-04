'use strict';

const express = require('express');
const router  = express.Router();
const { getSearchProvider } = require('../services/search');

// GET /api/v1/search/products?q=...&page=&pageSize=
// Storefront product search through the pluggable SearchProvider
// (postgres FTS by default; opensearch when configured).
router.get('/products', async (req, res, next) => {
    const q = (req.query.q || '').trim();
    if (!q) return next({ status: 400, message: 'q is required' });

    const pageSize = Math.min(parseInt(req.query.pageSize, 10) || 20, 100);
    const page     = Math.max(parseInt(req.query.page, 10) || 1, 1);

    try {
        const provider = await getSearchProvider();
        const { hits, total } = await provider.search(q, {
            limit: pageSize,
            offset: (page - 1) * pageSize,
        });
        res.locals.results = { products: hits, total, page, pageSize, provider: provider.provider };
        res.locals.status  = 200;
        res.locals.message = 'Search results';
        next();
    } catch (err) {
        next({ status: 500, message: 'Search failed' });
    }
});

module.exports = router;
