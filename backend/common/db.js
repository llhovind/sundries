require('dotenv').config();
var pg = require('pg');
var types = pg.types;
var pgPool = pg.Pool;

types.setTypeParser(1700, function (val) {

    if (val) {
        return parseFloat(val);
    }
    return 0;
});

types.setTypeParser(1082, function (val) {
    return val;
});

// DB_SSL: 'true' = TLS with certificate verification (recommended in production),
//         'no-verify' = TLS without verification (legacy default, self-signed certs),
//         'false' = plaintext (local dev / same-host installs).
function sslConfig() {
    switch ((process.env.DB_SSL || 'no-verify').toLowerCase()) {
        case 'false': return false;
        case 'true':  return { rejectUnauthorized: true };
        default:      return { rejectUnauthorized: false };
    }
}

var pgConfig = {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
    ssl: sslConfig()
};

var pool = new pgPool(pgConfig);

var DB = (function () {

    return {
        query: query
    };


    function query(qry, data) {

        return new Promise((resolve, reject) => {

            pool.query(qry, data, (err, res) => {
                if (err) {
                    console.log(err);
                    reject(err);
                } else {
                    resolve(res);
                }
            });
        });
    }


}());

async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { DB, pool, withTransaction, pgConfig };
