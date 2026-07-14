#!/bin/sh
set -e

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [entrypoint] $*"; }

log "=== Privacy Remover startup ==="
log "Node: $(node --version)"
log "NODE_ENV: ${NODE_ENV:-not set}"
log "DATABASE_URL: ${DATABASE_URL:-not set}"
log "PORT: ${PORT:-3000}"

DB_PATH="$(echo "$DATABASE_URL" | sed 's|^file:||')"
DB_DIR="$(dirname "$DB_PATH")"
if [ -n "$DB_DIR" ] && [ "$DB_DIR" != "." ]; then
  mkdir -p "$DB_DIR"
  log "Ensured DB directory: $DB_DIR"
fi

# 20260701 RG - Il progetto non ha storico di migrazioni: si applica lo schema
# direttamente con `db push` (idempotente). --accept-data-loss serve perché db push
# può droppare colonne se lo schema cambia in modo incompatibile: attenzione se un
# giorno ci saranno dati da preservare.
log "Applying database schema (prisma db push)..."
npx prisma db push --skip-generate --accept-data-loss
log "Schema applied."

# 20260701 RG - Il seed si auto-salta se il catalogo a DB è già alla versione
# corrente, quindi può girare a ogni avvio: è così che un'installazione esistente
# riceve i broker aggiunti in una nuova versione dell'immagine.
log "Syncing broker catalog..."
node dist/seed.js || log "Seed step failed (non-fatal), continuing."

log "Starting app..."
exec node dist/index.js
