const db = require('../common/db').DB;

const Vendors = (function () {

    return { findAll, findOne, create, update };

    function findAll({ search } = {}) {
        const params = [];
        let where = '';
        if (search) {
            params.push('%' + search + '%');
            where = 'WHERE name ILIKE $1';
        }
        return db.query(
            `SELECT id, name, address, city, state, country, zip, phone, fax, website, notes
             FROM vendors ${where} ORDER BY lower(name)`,
            params
        ).then(res => res.rows);
    }

    function findOne(id) {
        return db.query(
            `SELECT id, name, address, city, state, country, zip, phone, fax, website, notes,
                    _create_ts, _modify_ts
             FROM vendors WHERE id = $1`,
            [id]
        ).then(res => res.rows[0] || null);
    }

    function create(data, userId) {
        const { name, address, city, state, country, zip, phone, fax, website, notes } = data;
        if (!name) throw new Error('name is required');
        return db.query(
            `INSERT INTO vendors (id, name, address, city, state, country, zip, phone, fax, website, notes,
                                  _create_ts, _create_user_id, _modify_ts, _modify_user_id)
             VALUES (nextval('vendors_id_seq'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(),$11,NOW(),$11)
             RETURNING id, name`,
            [name, address||null, city||null, state||null, country||null, zip||null,
             phone||null, fax||null, website||null, notes||null, userId]
        ).then(res => res.rows[0]);
    }

    function update(id, data, userId) {
        const { name, address, city, state, country, zip, phone, fax, website, notes } = data;
        return db.query(
            `UPDATE vendors SET name=$1, address=$2, city=$3, state=$4, country=$5, zip=$6,
                phone=$7, fax=$8, website=$9, notes=$10, _modify_ts=NOW(), _modify_user_id=$11
             WHERE id=$12 RETURNING id, name`,
            [name, address||null, city||null, state||null, country||null, zip||null,
             phone||null, fax||null, website||null, notes||null, userId, id]
        ).then(res => res.rows[0] || null);
    }

}());

module.exports = Vendors;
