'use strict';

const { DB: db } = require('../../common/db');

/**
 * OpenSearch adapter — for catalogs where Postgres FTS runs out of road
 * (faceting, typo tolerance, 100k+ products).
 *
 * Requires: `npm install @opensearch-project/opensearch` and env
 * OPENSEARCH_URL (e.g. https://search1:9200; server lives in the DMZ, only
 * the API talks to it). Optional: OPENSEARCH_INDEX (default 'products').
 *
 * Indexing is outbox-driven (see searchService/jobs): catalog writes enqueue
 * rows transactionally; the worker drains them here with idempotent upserts,
 * so OpenSearch downtime delays freshness but never loses updates.
 */
const OpenSearchAdapter = (function () {

    const INDEX = process.env.OPENSEARCH_INDEX || 'products';
    let client = null;

    function os() {
        if (!client) {
            if (!process.env.OPENSEARCH_URL) {
                throw new Error('OPENSEARCH_URL is required for the opensearch search provider');
            }
            // eslint-disable-next-line global-require
            const { Client } = require('@opensearch-project/opensearch');
            client = new Client({
                node: process.env.OPENSEARCH_URL,
                requestTimeout: 5000,
                maxRetries: 2,
            });
        }
        return client;
    }

    return { provider: 'opensearch', search, processOutbox, reindexAll };

    async function search(query, { limit = 20, offset = 0 } = {}) {
        const res = await os().search({
            index: INDEX,
            body: {
                from: offset,
                size: limit,
                query: {
                    multi_match: {
                        query,
                        fields: ['name^3', 'brand^2', 'descr', 'skus'],
                        fuzziness: 'AUTO',
                    },
                },
            },
        });
        const body = res.body;
        return {
            hits: body.hits.hits.map(h => h._source),
            total: body.hits.total.value,
        };
    }

    /** Drains pending outbox rows into the index. At-least-once, idempotent. */
    async function processOutbox(batchSize = 200) {
        const pending = await db.query(
            `SELECT DISTINCT ON (_product_no) id, _product_no, op
             FROM search_outbox WHERE processed_at IS NULL
             ORDER BY _product_no, id DESC
             LIMIT $1`,
            [batchSize]
        );
        if (!pending.rows.length) return { processed: 0, provider: 'opensearch' };

        const upserts = pending.rows.filter(r => r.op === 'upsert').map(r => Number(r._product_no));
        const deletes = pending.rows.filter(r => r.op === 'delete').map(r => Number(r._product_no));

        const bulk = [];
        if (upserts.length) {
            const docs = await fetchDocs(upserts);
            for (const doc of docs) {
                bulk.push({ index: { _index: INDEX, _id: String(doc.product_no) } });
                bulk.push(doc);
            }
            // products that vanished between enqueue and drain → delete
            const found = new Set(docs.map(d => Number(d.product_no)));
            upserts.filter(p => !found.has(p)).forEach(p =>
                bulk.push({ delete: { _index: INDEX, _id: String(p) } }));
        }
        deletes.forEach(p => bulk.push({ delete: { _index: INDEX, _id: String(p) } }));

        if (bulk.length) {
            const res = await os().bulk({ body: bulk });
            if (res.body.errors) {
                const failed = res.body.items.filter(i => (i.index || i.delete || {}).error);
                throw new Error(`OpenSearch bulk had ${failed.length} failures (will retry)`);
            }
        }

        // Only after a successful bulk: mark every pending row for these
        // products processed (including older duplicates we skipped).
        await db.query(
            `UPDATE search_outbox SET processed_at = NOW()
             WHERE processed_at IS NULL AND _product_no = ANY($1)`,
            [pending.rows.map(r => Number(r._product_no))]
        );
        return { processed: pending.rows.length, provider: 'opensearch' };
    }

    async function reindexAll() {
        const all = await db.query(`SELECT product_no FROM products WHERE status = 'active'`);
        await db.query(
            `INSERT INTO search_outbox (_product_no, op)
             SELECT product_no, 'upsert' FROM products WHERE status = 'active'`);
        let total = 0;
        for (;;) {
            const { processed } = await processOutbox();
            total += processed;
            if (!processed) break;
        }
        return { reindexed: all.rows.length, provider: 'opensearch', drained: total };
    }

    async function fetchDocs(productNos) {
        const res = await db.query(
            `SELECT p.product_no, p.name, p.brand, p.descr, p.primary_image,
                    p.sell_method, p.base_uom,
                    MIN(v.price) AS price_from,
                    COUNT(v.variant_no)::int AS variant_count,
                    COALESCE(ARRAY_AGG(v.sku) FILTER (WHERE v.sku IS NOT NULL), '{}') AS skus
             FROM products p
             LEFT JOIN product_variants v ON v._product_no = p.product_no AND v.status = 'active'
             WHERE p.product_no = ANY($1) AND p.status = 'active'
             GROUP BY p.product_no`,
            [productNos]
        );
        return res.rows;
    }

}());

module.exports = OpenSearchAdapter;
