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

BROKER_COUNT="$(node -e "
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  p.broker.count().then((n) => { console.log(n); return p.\$disconnect(); }).catch(() => { console.log(0); process.exit(0); });
" 2>/dev/null || echo 0)"
if [ "$BROKER_COUNT" = "0" ]; then
  log "No brokers found — seeding pre-loaded broker list..."
  node dist/seed.js || log "Seed step failed (non-fatal), continuing."
else
  log "Brokers already present ($BROKER_COUNT) — skipping seed."
fi

log "Starting app..."
exec node dist/index.js
