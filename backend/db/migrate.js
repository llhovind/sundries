require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { pool, pgConfig } = require('../common/db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Fresh-install convenience: create the target database when it does not
// exist yet, by connecting to the always-present 'postgres' maintenance DB
// with the same credentials. Requires CREATEDB on the app user; if it is
// missing we fail with a clear instruction instead of a FATAL 3D000.
async function ensureDatabaseExists() {
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    try {
        await admin.connect();
        const res = await admin.query(
            'SELECT 1 FROM pg_database WHERE datname = $1', [pgConfig.database]
        );
        if (res.rowCount === 0) {
            console.log(`Database "${pgConfig.database}" does not exist — creating it...`);
            // Identifier, not a value: cannot be parameterized. Quote defensively.
            await admin.query(`CREATE DATABASE "${pgConfig.database.replace(/"/g, '""')}"`);
            console.log(`  ✓ created ${pgConfig.database}`);
        }
    } catch (err) {
        if (err.code === '42501') {   // insufficient_privilege
            console.error(
                `Database "${pgConfig.database}" does not exist and user "${pgConfig.user}" ` +
                `may not create it. Create it manually:\n` +
                `  psql -h ${pgConfig.host} -U postgres -c 'CREATE DATABASE "${pgConfig.database}"'`
            );
            process.exit(1);
        }
        throw err;
    } finally {
        await admin.end();
    }
}

async function run() {
    await ensureDatabaseExists();
    const client = await pool.connect();
    try {
        // Ensure tracking table exists
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename   TEXT        PRIMARY KEY,
                applied_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // Get already-applied migrations
        const { rows } = await client.query('SELECT filename FROM schema_migrations');
        const applied = new Set(rows.map(r => r.filename));

        // Read migration files sorted by name
        const files = fs.readdirSync(MIGRATIONS_DIR)
            .filter(f => f.endsWith('.sql'))
            .sort();

        const pending = files.filter(f => !applied.has(f));

        if (pending.length === 0) {
            console.log('No pending migrations.');
            return;
        }

        for (const file of pending) {
            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
            console.log(`Applying ${file}...`);
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query(
                    'INSERT INTO schema_migrations (filename) VALUES ($1)',
                    [file]
                );
                await client.query('COMMIT');
                console.log(`  ✓ ${file}`);
            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`  ✗ ${file}: ${err.message}`);
                process.exit(1);
            }
        }
    } finally {
        client.release();
        await pool.end();
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
