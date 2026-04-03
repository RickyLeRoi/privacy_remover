#!/bin/sh
set -e

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [entrypoint] $*"; }

log "=== Privacy Remover startup ==="
log "Node: $(node --version)"
log "NODE_ENV: ${NODE_ENV:-not set}"
log "DATABASE_URL host: $(echo "$DATABASE_URL" | sed 's|.*@||;s|/.*||')"
log "PORT: ${PORT:-3000}"

log "Waiting for database to be ready..."
until node -e "
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  c.connect().then(() => { c.end(); process.exit(0); }).catch(() => process.exit(1));
" 2>/dev/null; do
  log "  ...db not ready yet, retrying in 2s"
  sleep 2
done
log "Database is ready."

log "Running Prisma migrations..."
npx prisma migrate deploy
log "Migrations complete."

log "Starting app..."
exec node dist/index.js
