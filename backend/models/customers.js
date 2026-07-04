const db = require('../common/db').DB;
const { withTransaction } = require('../common/db');

const Customers = (function () {

    return { findAll, findOne, findByUserId, create, update, upsertForUser, ensureGuestAccount };

    function findAll({ search, limit = 50, offset = 0 } = {}) {
        const params = [];
        let where = '';
        if (search) {
            params.push('%' + search + '%');
            where = `WHERE name ILIKE $1 OR email ILIKE $1`;
        }
        params.push(offset, limit);
        return db.query(
            `SELECT id, name, email, city, state, country, phone,
                    COUNT(*) OVER() AS _total
             FROM customers ${where}
             ORDER BY lower(name)
             OFFSET $${params.length - 1} LIMIT $${params.length}`,
            params
        ).then(res => {
            const total = res.rows.length > 0 ? +res.rows[0]._total : 0;
            const rows  = res.rows.map(({ _total, ...r }) => r);
            return { rows, total };
        });
    }

    function findByUserId(userId) {
        return db.query(
            `SELECT id, name, address, city, state, country, zip, phone
             FROM customers WHERE user_id = $1`,
            [userId]
        ).then(res => res.rows[0] || null);
    }

    function findOne(id) {
        return db.query(
            `SELECT id, name, address, city, state, country, zip, phone, email, notes,
                    _create_ts, _modify_ts
             FROM customers WHERE id = $1`,
            [id]
        ).then(res => res.rows[0] || null);
    }

    function create(data, userId) {
        const { name, address, city, state, country, zip, phone, email, notes } = data;
        if (!name) throw new Error('name is required');
        return db.query(
            `INSERT INTO customers (id, name, address, city, state, country, zip, phone, email, notes,
                                    _create_ts, _create_user_id, _modify_ts, _modify_user_id)
             VALUES (nextval('customers_id_seq'), $1,$2,$3,$4,$5,$6,$7,$8,$9, NOW(),$10,NOW(),$10)
             RETURNING id, name`,
            [name, address||null, city||null, state||null, country||null,
             zip||null, phone||null, email||null, notes||null, userId]
        ).then(res => res.rows[0]);
    }

    function update(id, data, userId) {
        const { name, address, city, state, country, zip, phone, email, notes } = data;
        return db.query(
            `UPDATE customers SET name=$1, address=$2, city=$3, state=$4, country=$5,
                zip=$6, phone=$7, email=$8, notes=$9, _modify_ts=NOW(), _modify_user_id=$10
             WHERE id=$11 RETURNING id, name`,
            [name, address||null, city||null, state||null, country||null,
             zip||null, phone||null, email||null, notes||null, userId, id]
        ).then(res => res.rows[0] || null);
    }

    /**
     * Insert or update the customer profile owned by the given user.
     * email and notes are intentionally excluded — email is the auth key and
     * notes are admin-only; neither should be self-edited by the user.
     *
     * @param {number} userId  - req.user.id from the JWT
     * @param {object} data    - { name, address, city, state, country, zip, phone }
     * @returns {Promise<object>}
     */
    function upsertForUser(userId, data) {
        const { name, address, city, state, country, zip, phone } = data;
        if (!name) throw new Error('name is required');
        return db.query(
            `INSERT INTO customers (id, user_id, name, address, city, state, country, zip, phone,
                                    _create_ts, _create_user_id, _modify_ts, _modify_user_id)
             VALUES (nextval('customers_id_seq'),$1,$2,$3,$4,$5,$6,$7,$8, NOW(),$1,NOW(),$1)
             ON CONFLICT (user_id) DO UPDATE
               SET name=$2, address=$3, city=$4, state=$5, country=$6, zip=$7, phone=$8,
                   _modify_ts=NOW(), _modify_user_id=$1
             RETURNING id, name, address, city, state, country, zip, phone`,
            [userId, name, address||null, city||null, state||null, country||null, zip||null, phone||null]
        ).then(res => res.rows[0]);
    }

    /**
     * Guest checkout: resolve (or create) the implicit account for an email.
     *
     * - Email belongs to an existing user → reuse that user and their customer
     *   row (creating one if missing). A returning registered customer who
     *   checks out as a guest keeps a single order history.
     * - Unknown email → create a guest user (passwordless — they can log in
     *   any time via emailed OTP, per the standard flow) plus a guest
     *   customer profile.
     *
     * @param {object} data - { email, name, address, city, state, country, zip, phone }
     * @returns {Promise<{userId:number, customerId:number, created:boolean}>}
     */
    function ensureGuestAccount({ email, name, address, city, state, country, zip, phone }) {
        if (!email) throw new Error('email is required');
        if (!name)  throw new Error('name is required');

        return withTransaction(async (client) => {
            let created = false;

            let userRes = await client.query(
                `SELECT id FROM users WHERE lower(email) = lower($1)`, [email]
            );
            let userId;
            if (userRes.rows.length) {
                userId = userRes.rows[0].id;
            } else {
                const ins = await client.query(
                    `INSERT INTO users (email, role, status, is_guest)
                     VALUES ($1, 'customer', 'active', TRUE)
                     RETURNING id`,
                    [email]
                );
                userId  = ins.rows[0].id;
                created = true;
                await client.query(
                    `INSERT INTO user_roles (user_id, role_no)
                     SELECT $1, role_no FROM roles WHERE code = 'customer'`,
                    [userId]
                );
            }

            const cust = await client.query(
                `INSERT INTO customers (user_id, name, email, address, city, state, country, zip, phone,
                                        is_guest, _create_ts, _create_user_id, _modify_ts, _modify_user_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(),$1,NOW(),$1)
                 ON CONFLICT (user_id) DO UPDATE
                   SET _modify_ts = NOW()      -- keep existing profile; order carries its own address snapshot
                 RETURNING id`,
                [userId, name, email, address || null, city || null, state || null,
                 country || null, zip || null, phone || null, created]
            );

            return { userId, customerId: cust.rows[0].id, created };
        });
    }

}());

module.exports = Customers;
