'use strict';

const { DB: db } = require('../../common/db');

/**
 * Postgres full-text search adapter — the zero-infrastructure default.
 * Searches the generated products.search_tsv (GIN-indexed) with
 * websearch_to_tsquery, falling back to prefix matching for single short
 * terms so partial SKU/name typing still hits.
 *
 * Because it queries the source of truth directly, the outbox is a no-op
 * here — the index can never be stale.
 */
const PostgresSearchAdapter = (function () {

    return { provider: 'postgres', search, processOutbox, reindexAll };

    async function search(query, { limit = 20, offset = 0 } = {}) {
        const res = await db.query(
            `SELECT p.product_no, p.name, p.brand, p.descr, p.primary_image, p.sell_method, p.base_uom,
                    MIN(v.price)        AS price_from,
                    COUNT(v.variant_no)::int AS variant_count,
                    ts_rank(p.search_tsv, q) AS rank,
                    COUNT(*) OVER()::int AS _total
             FROM products p
             CROSS JOIN websearch_to_tsquery('english', $1) q
             LEFT JOIN product_variants v ON v._product_no = p.product_no AND v.status = 'active'
             WHERE p.status = 'active'
               AND (p.search_tsv @@ q OR p.name ILIKE $2)
             GROUP BY p.product_no, q
             ORDER BY rank DESC, p.name
             OFFSET $3 LIMIT $4`,
            [query, query.replace(/[%_]/g, '') + '%', offset, limit]
        );
        const total = res.rows.length ? res.rows[0]._total : 0;
        return { hits: res.rows.map(({ _total, rank, ...r }) => r), total };
    }

    async function processOutbox() {
        // Source-of-truth search — nothing to sync. Prune handled rows anyway
        // so the outbox doesn't grow forever on installs that later switch
        // adapters.
        const res = await db.query(
            `UPDATE search_outbox SET processed_at = NOW() WHERE processed_at IS NULL`);
        return { processed: res.rowCount, provider: 'postgres' };
    }

    async function reindexAll() {
        return { reindexed: 0, provider: 'postgres' };   // always current
    }

}());

module.exports = PostgresSearchAdapter;
