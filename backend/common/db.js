require('dotenv').config();
const { log } = require('./logger');
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
                    log('error', 'database query failed', { error: err });
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

/**
 * withTransaction plus actor attribution for the DB audit triggers
 * (fn_audit_row): sets the per-transaction app.user_id / app.ip /
 * app.correlation_id settings before running fn, so every row the triggers
 * write inside this transaction is attributed to the acting user and request.
 *
 * ALL writes to audited tables (product_variants, user_roles, refunds,
 * shipping_rules, tax_rates, app_settings, warehouses, roles,
 * role_permissions) must go through this — a plain query() or bare
 * withTransaction() produces an anonymous audit row.
 *
 * @param {number|string|null} actorId - acting user id; null only for
 *        system-initiated writes (jobs), which audit as anonymous by design
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
function withAudit(actorId, fn) {
    const requestContext = require('./requestContext');
    return withTransaction(async (client) => {
        const ctx = requestContext.get();
        await client.query(
            `SELECT set_config('app.user_id', $1, true),
                    set_config('app.ip', $2, true),
                    set_config('app.correlation_id', $3, true)`,
            [actorId == null ? '' : String(actorId), ctx?.ip ?? '', ctx?.correlationId ?? '']
        );
        return fn(client);
    });
}

module.exports = { DB, pool, withTransaction, withAudit, pgConfig };
