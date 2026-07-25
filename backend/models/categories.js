const { DB: db, withTransaction } = require('../common/db');

const Categories = (function () {

    return {
        findAll,
        findOne,
        create,
        update,
        remove,
        getForProduct,
        setForProduct
    };

    function findAll({ search, limit = 100, offset = 0 } = {}) {
        const params = [];
        let where = '';
        if (search) {
            params.push('%' + search + '%');
            where = 'WHERE name ILIKE $1';
        }
        params.push(offset, limit);
        return db.query(
            `SELECT id, name, _create_ts, _modify_ts,
                    COUNT(*) OVER() AS _total
             FROM categories ${where}
             ORDER BY lower(name)
             OFFSET $${params.length - 1} LIMIT $${params.length}`,
            params
        ).then(res => {
            const total = res.rows.length > 0 ? +res.rows[0]._total : 0;
            const rows  = res.rows.map(({ _total, ...r }) => r);
            return { rows, total };
        });
    }

    function findOne(id) {
        return db.query(
            'SELECT id, name, _create_ts, _modify_ts FROM categories WHERE id = $1',
            [id]
        ).then(res => res.rows[0] || null);
    }

    function create(name, userId) {
        return db.query(
            `INSERT INTO categories (id, name, _create_ts, _create_user_id, _modify_ts, _modify_user_id)
             VALUES (nextval('categories_id_seq'), $1, NOW(), $2, NOW(), $2)
             RETURNING id, name`,
            [name, userId]
        ).then(res => res.rows[0]);
    }

    function update(id, name, userId) {
        return db.query(
            `UPDATE categories SET name = $1, _modify_ts = NOW(), _modify_user_id = $2
             WHERE id = $3 RETURNING id, name`,
            [name, userId, id]
        ).then(res => res.rows[0] || null);
    }

    function remove(id) {
        return db.query(
            'DELETE FROM categories WHERE id = $1 RETURNING id',
            [id]
        ).then(res => res.rows[0] || null);
    }

    function getForProduct(productNo) {
        return db.query(
            `SELECT c.id, c.name FROM categories c
             JOIN product_categories pc ON pc._category_id = c.id
             WHERE pc._product_no = $1
             ORDER BY lower(c.name)`,
            [productNo]
        ).then(res => res.rows);
    }

    function setForProduct(productNo, categoryIds) {
        // Replace all categories for this product atomically.
        // Must use withTransaction (dedicated client) — db.query() draws from the pool
        // and different calls can land on different connections, breaking transaction semantics.
        return withTransaction(async (client) => {
            await client.query('DELETE FROM product_categories WHERE _product_no = $1', [productNo]);
            if (categoryIds && categoryIds.length) {
                const rows = categoryIds.map((_, i) => `($1, $${i + 2})`).join(', ');
                await client.query(
                    `INSERT INTO product_categories (_product_no, _category_id) VALUES ${rows}`,
                    [productNo, ...categoryIds]
                );
            }
        });
    }

}());

module.exports = Categories;
