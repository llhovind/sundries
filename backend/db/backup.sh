#!/usr/bin/env bash
# ============================================================================
# backup.sh — scheduled logical backup of the store database.
#
# Reads connection settings from backend/.env (or the environment), writes a
# compressed pg_dump custom-format archive, and prunes archives older than
# BACKUP_RETENTION_DAYS. Safe to run while the application is live.
#
# Schedule it with cron, e.g. daily at 02:15:
#   15 2 * * *  /path/to/backend/db/backup.sh >> /var/log/store-backup.log 2>&1
#
# Verify restorability regularly: a backup that has never been restored is
# not a backup. See restore.sh and the README "Backup & recovery" section.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../.env}"

# Load .env without clobbering variables already set in the environment.
if [[ -f "$ENV_FILE" ]]; then
    while IFS='=' read -r key value; do
        [[ "$key" =~ ^[A-Z_]+$ ]] || continue
        [[ -z "${!key:-}" ]] && export "$key=$value"
    done < <(grep -v '^\s*#' "$ENV_FILE" | grep '=')
fi

: "${DB_HOST:?DB_HOST is required}"
: "${DB_USER:?DB_USER is required}"
: "${DB_NAME:?DB_NAME is required}"
DB_PORT="${DB_PORT:-5432}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/store}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

export PGPASSWORD="${DB_PASSWORD:-}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
ARCHIVE="$BACKUP_DIR/${DB_NAME}_${STAMP}.dump"

echo "[$(date -Is)] Backing up ${DB_NAME}@${DB_HOST}:${DB_PORT} → ${ARCHIVE}"
pg_dump --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" \
        --format=custom --compress=6 --no-owner \
        --file="$ARCHIVE" "$DB_NAME"

# Prune old archives.
find "$BACKUP_DIR" -name "${DB_NAME}_*.dump" -mtime "+${BACKUP_RETENTION_DAYS}" -delete

echo "[$(date -Is)] Done. $(du -h "$ARCHIVE" | cut -f1) written. Retained archives:"
ls -1t "$BACKUP_DIR"/${DB_NAME}_*.dump | head -5
