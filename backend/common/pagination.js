'use strict';

/**
 * Shared pagination utilities — no Express imports, fully testable in isolation.
 */
const pagination = (function () {

    return { parsePageQuery, pageResult };

    /**
     * Parse page/pageSize from Express query params.
     * Returns { page, pageSize, offset } as integers.
     *
     * @param {object} query  - req.query
     * @param {object} opts   - { defaultPageSize, maxPageSize }
     */
    function parsePageQuery(query, { defaultPageSize = 25, maxPageSize = 100 } = {}) {
        const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || defaultPageSize, 1), maxPageSize);
        const page     = Math.max(parseInt(query.page,     10) || 1, 1);
        const offset   = (page - 1) * pageSize;
        return { page, pageSize, offset };
    }

    /**
     * Build the standard list content envelope.
     * Every list endpoint returns exactly this shape inside `content`.
     *
     * @param {string} collectionKey  - e.g. 'items', 'customers'
     * @param {Array}  rows           - the result rows from the model
     * @param {number} total          - total matching records (for pagination)
     * @param {number} page           - current page number
     * @param {number} pageSize       - rows per page
     */
    function pageResult(collectionKey, rows, total, page, pageSize) {
        return {
            [collectionKey]: rows,
            total,
            page,
            pageSize,
        };
    }

}());

module.exports = pagination;
