#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/backup.sh — PostgreSQL encrypted backup for Privacy Remover
#
# Uso:
#   chmod +x scripts/backup.sh
#   ./scripts/backup.sh
#
# Schedulare con cron (ogni notte alle 02:00):
#   0 2 * * * /path/to/privacy-remover/scripts/backup.sh >> /var/log/privacy-remover-backup.log 2>&1
#
# Richiede: pg_dump, gzip, openssl
# La passphrase viene letta da BACKUP_PASSPHRASE (env o .env)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Load .env if present
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
[ -f "$ENV_FILE" ] && export $(grep -v '^#' "$ENV_FILE" | xargs)

BACKUP_DIR="${BACKUP_DIR:-$SCRIPT_DIR/../backups}"
DB_URL="${DATABASE_URL:-}"
PASSPHRASE="${BACKUP_PASSPHRASE:-}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
OUTFILE="$BACKUP_DIR/db_backup_${TIMESTAMP}.sql.gz.enc"

if [ -z "$DB_URL" ]; then
  echo "[backup] ERROR: DATABASE_URL not set" >&2
  exit 1
fi

if [ -z "$PASSPHRASE" ]; then
  echo "[backup] ERROR: BACKUP_PASSPHRASE not set" >&2
  echo "[backup] Add BACKUP_PASSPHRASE=<strong_password> to your .env" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

echo "[backup] Starting backup at $TIMESTAMP..."
pg_dump "$DB_URL" \
  | gzip \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -pass pass:"$PASSPHRASE" \
  > "$OUTFILE"

SIZE=$(du -sh "$OUTFILE" | cut -f1)
echo "[backup] Done: $OUTFILE ($SIZE)"

# Rimuovi backup più vecchi di 30 giorni
find "$BACKUP_DIR" -name "db_backup_*.sql.gz.enc" -mtime +30 -delete
echo "[backup] Old backups cleaned up."

# Per ripristinare:
# openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass pass:"$PASSPHRASE" -in db_backup_xxx.sql.gz.enc \
#   | gunzip | psql "$DATABASE_URL"
