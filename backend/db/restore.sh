#!/usr/bin/env bash
# ============================================================================
# restore.sh — restore the store database from a backup.sh archive.
#
# Usage:
#   ./restore.sh /var/backups/store/store_20260703_021500.dump [target_db_name]
#
# Restores into target_db_name (default: DB_NAME from .env). The target
# database is DROPPED and recreated — this script asks for confirmation.
# Stop the application (or point it elsewhere) before restoring.
#
# For point-in-time recovery beyond daily granularity use your provider's
# native mechanism (RDS automated backups / WAL archiving) — this script is
# the simple, universal path.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../.env}"

if [[ -f "$ENV_FILE" ]]; then
    while IFS='=' read -r key value; do
        [[ "$key" =~ ^[A-Z_]+$ ]] || continue
        [[ -z "${!key:-}" ]] && export "$key=$value"
    done < <(grep -v '^\s*#' "$ENV_FILE" | grep '=')
fi

ARCHIVE="${1:?Usage: restore.sh <archive.dump> [target_db_name]}"
TARGET_DB="${2:-${DB_NAME:?DB_NAME is required}}"

: "${DB_HOST:?DB_HOST is required}"
: "${DB_USER:?DB_USER is required}"
DB_PORT="${DB_PORT:-5432}"
export PGPASSWORD="${DB_PASSWORD:-}"

[[ -f "$ARCHIVE" ]] || { echo "Archive not found: $ARCHIVE" >&2; exit 1; }

echo "About to DROP and recreate database '${TARGET_DB}' on ${DB_HOST}:${DB_PORT}"
echo "and restore from: ${ARCHIVE}"
read -r -p "Type the database name to confirm: " CONFIRM
[[ "$CONFIRM" == "$TARGET_DB" ]] || { echo "Confirmation mismatch — aborting."; exit 1; }

psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname=postgres \
     -c "DROP DATABASE IF EXISTS \"${TARGET_DB}\" WITH (FORCE);"
psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname=postgres \
     -c "CREATE DATABASE \"${TARGET_DB}\";"

echo "[$(date -Is)] Restoring…"
pg_restore --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" \
           --dbname="$TARGET_DB" --no-owner --exit-on-error "$ARCHIVE"

echo "[$(date -Is)] Restore complete. Sanity check:"
psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$TARGET_DB" -tA \
     -c "SELECT 'migrations: ' || COUNT(*) FROM schema_migrations
         UNION ALL SELECT 'ledger rows: ' || COUNT(*) FROM inventory_transactions
         UNION ALL SELECT 'orders: '      || COUNT(*) FROM orders;"
