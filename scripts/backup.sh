#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/backup.sh — backup cifrato di Privacy Remover (SQLite + prove)
#
# 20260715 RG - Questo script usava pg_dump/psql, cioè PostgreSQL, mentre il database
# è SQLite: non ha mai prodotto un backup, falliva alla prima riga utile. Ora usa
# `sqlite3 .backup`, che è l'unico modo corretto di copiare un DB SQLite mentre l'app
# ci sta scrivendo (un `cp` a caldo può catturare pagine a metà transazione e dare un
# file corrotto, che ti accorgi essere inutile solo il giorno del ripristino).
#
# Include anche evidence/: senza gli allegati, il backup del DB da solo lascia righe
# Evidence che puntano a file inesistenti.
#
# Uso:
#   chmod +x scripts/backup.sh
#   ./scripts/backup.sh
#
# Cron (ogni notte alle 02:00):
#   0 2 * * * /path/to/privacy-remover/scripts/backup.sh >> /var/log/privacy-remover-backup.log 2>&1
#
# Richiede: sqlite3, tar, gzip, openssl
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

# 20260715 RG - `export $(grep ... | xargs)` spezzava i valori con spazi: SMTP_FROM è
# "Privacy Bot <removal@...>" e finiva troncato. `set -a` + source rispetta le quote.
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
PASSPHRASE="${BACKUP_PASSPHRASE:-}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
OUTFILE="$BACKUP_DIR/backup_${TIMESTAMP}.tar.gz.enc"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[backup] ERRORE: DATABASE_URL non impostata" >&2
  exit 1
fi

if [ -z "$PASSPHRASE" ]; then
  echo "[backup] ERRORE: BACKUP_PASSPHRASE non impostata" >&2
  echo "[backup] Aggiungi BACKUP_PASSPHRASE=<passphrase_robusta> al tuo .env" >&2
  exit 1
fi

# DATABASE_URL ha la forma file:/app/data/app.db — qui serve il path nudo.
DB_PATH="${DATABASE_URL#file:}"
if [ ! -f "$DB_PATH" ]; then
  echo "[backup] ERRORE: database non trovato: $DB_PATH" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[backup] ERRORE: sqlite3 non installato (apt install sqlite3 / brew install sqlite)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAGING="$(mktemp -d)"
# Ripulisce la staging anche se lo script muore a metà: conterrebbe una copia in
# chiaro del database.
trap 'rm -rf "$STAGING"' EXIT

echo "[backup] Avvio backup $TIMESTAMP..."

# .backup è transazionale: produce un file coerente anche con l'app in scrittura.
sqlite3 "$DB_PATH" ".backup '$STAGING/app.db'"
echo "[backup] Database copiato ($(du -h "$STAGING/app.db" | cut -f1))."

if [ -d "$ROOT_DIR/evidence" ]; then
  cp -R "$ROOT_DIR/evidence" "$STAGING/evidence"
  echo "[backup] Prove incluse ($(find "$STAGING/evidence" -type f | wc -l | tr -d ' ') file)."
else
  echo "[backup] Nessuna cartella evidence/ da includere."
fi

# 20260715 RG - La passphrase passa da una variabile d'ambiente, non da `-pass pass:`:
# gli argomenti di un processo sono leggibili da chiunque con `ps` sulla stessa macchina.
BACKUP_PASSPHRASE="$PASSPHRASE" tar -C "$STAGING" -czf - . \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -pass env:BACKUP_PASSPHRASE \
  > "$OUTFILE"

chmod 600 "$OUTFILE"
echo "[backup] Fatto: $OUTFILE ($(du -h "$OUTFILE" | cut -f1))"

# Verifica che l'archivio sia davvero decifrabile: un backup che non si apre non è un
# backup, e tanto vale scoprirlo adesso invece che il giorno del ripristino.
if BACKUP_PASSPHRASE="$PASSPHRASE" openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
     -pass env:BACKUP_PASSPHRASE -in "$OUTFILE" 2>/dev/null | tar -tzf - >/dev/null 2>&1; then
  echo "[backup] Verifica OK: l'archivio si decifra e si apre."
else
  echo "[backup] ERRORE: l'archivio non supera la verifica di decifratura!" >&2
  exit 1
fi

find "$BACKUP_DIR" -name "backup_*.tar.gz.enc" -mtime +30 -delete
echo "[backup] Backup più vecchi di 30 giorni rimossi."

# Per ripristinare:
#   BACKUP_PASSPHRASE='...' openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
#     -pass env:BACKUP_PASSPHRASE -in backups/backup_XXX.tar.gz.enc | tar -xzf - -C /tmp/restore
#   # poi rimetti /tmp/restore/app.db al posto del DB e /tmp/restore/evidence/ al suo posto.
