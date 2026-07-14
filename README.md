# Privacy Remover

> **Progetto personale — uso familiare**  
> Questo software è un progetto privato, scritto per uso personale e familiare.  
> **Non ha valore legale**, non sostituisce una consulenza legale e non è pensato per essere distribuito o usato da terzi.  
> Le richieste generate dal sistema sono tentativi informali di opt-out; l'effettiva cancellazione dai data broker dipende esclusivamente dalla loro politica interna.

Servizio self-hosted per tenere traccia delle richieste di rimozione dei dati personali dai principali data broker italiani e internazionali. Gira sulla rete privata di casa, senza esposizione pubblica.

## Funzionalità

- Dashboard web (dark/light) per gestire persone, broker e pratiche di rimozione
- Generazione automatica di email di opt-out (GDPR Art. 17, CCPA, generica)
- Tracciamento stato per ogni pratica: inviata → confermata → verifica periodica
- Caricamento prove (screenshot, email di risposta, PDF) per ogni caso
- Parser IMAP: legge automaticamente le risposte dei broker dalla casella email e aggiorna lo stato delle pratiche
- Export CSV e PDF dei casi
- Scheduler integrato: segnala pratiche scadute, pianifica verifiche a 90 giorni
- Seed con ~22 broker pre-caricati (italiani e internazionali)
- Containerizzato con Docker; database **SQLite** embedded (un solo container, nessun DB server esterno)

## Avvio rapido

La password **non si configura in un file**: si imposta al primo login.

```bash
cp .env.example .env

# 1. Primo avvio, con la finestra di setup aperta:
ALLOW_SETUP=true docker compose up -d

# 2. Apri http://localhost:3000 e fai login con la password che vuoi (min 8 caratteri).
#    Viene hashata (bcrypt) e salvata nel DB: da ora è quella definitiva.

# 3. Richiudi il setup: togli ALLOW_SETUP e riavvia.
docker compose up -d

# (solo sviluppo locale, fuori Docker):
npm install
DATABASE_URL="file:./dev.db" npx prisma db push   # crea il DB SQLite
npm run db:seed                                    # carica i broker
npm run dev
```

## Deploy diretto sul server (senza Docker)

Requisiti sul server: **Node.js 20+**, **npm**. Il database è **SQLite** (file locale), nessun server DB da installare.

```bash
# 1. Copia i file sul server (es. via scp o git clone)
git clone <repo> privacy-remover && cd privacy-remover

# 2. Installa le dipendenze
npm ci --omit=dev

# 3. Compila TypeScript
npm run build          # esegue tsc → genera dist/

# 4. Configura l'ambiente
cp .env.example .env
nano .env              # imposta DATABASE_URL, SMTP_*, ecc. (la password si imposta al primo login)

# 5. Crea il DB SQLite e applica lo schema
npx prisma db push

# 6. (opzionale) Carica i broker pre-configurati
node dist/seed.js   # in dev: npm run db:seed

# 7. Avvia
node dist/index.js
```

Per tenerlo in esecuzione in background usa **pm2**:

```bash
npm install -g pm2
pm2 start dist/index.js --name privacy-remover
pm2 save && pm2 startup   # avvio automatico al boot
```

I log sono visibili con:

```bash
pm2 logs privacy-remover
# oppure direttamente:
node dist/index.js 2>&1 | tee app.log
```

Ogni riga di log ha il formato `ISO-timestamp [tag] messaggio`, es.:
```
2026-04-03T10:00:00.000Z [startup] NODE_ENV=production
2026-04-03T10:00:00.001Z [startup] Privacy Remover listening on http://0.0.0.0:3000
2026-04-03T10:00:00.002Z [scheduler] all jobs registered
2026-04-03T10:00:01.500Z [imap] connecting to imap.example.com:993 tls=true
```

La dashboard è disponibile su `http://localhost:3000`.

## Variabili d'ambiente principali

| Variabile | Descrizione |
|-----------|-------------|
| `DATABASE_URL` | Percorso file SQLite, es. `file:/app/data/app.db` |
| `ALLOW_SETUP` | Se `true`, la prima password digitata al login diventa quella definitiva (salvata nel DB). Rimuovila dopo il setup. |
| `ADMIN_PASSWORD_HASH` | Solo per recupero: se valorizzata ha la precedenza sulla password nel DB |
| `SMTP_HOST/PORT/USER/PASS` | Configurazione SMTP per l'invio email |
| `IMAP_HOST/PORT/USER/PASS` | Configurazione IMAP per il parsing delle risposte (opzionale) |
| `IMAP_ENABLED` | Abilita/disabilita il polling IMAP (`true`/`false`) |
| `BACKUP_PASSPHRASE` | Passphrase per la cifratura dei backup (AES-256) |

Vedere [.env.example](.env.example) per la lista completa.

## API (autenticazione Bearer token)

| Metodo | Path | Descrizione |
|--------|------|-------------|
| GET | `/api/persons` | Lista persone (fullName omesso) |
| POST | `/api/persons` | Crea persona |
| GET | `/api/persons/:id/response-identity` | Restituisce fullName (accesso esplicito, auditato) |
| GET | `/api/brokers` | Lista broker attivi |
| POST | `/api/brokers` | Aggiunge broker |
| PATCH | `/api/brokers/:id` | Aggiorna broker |
| DELETE | `/api/brokers/:id` | Disattiva broker (soft delete) |
| GET | `/api/cases` | Lista pratiche |
| POST | `/api/cases` | Apre una nuova pratica |
| POST | `/api/cases/:id/send` | Genera e invia la richiesta di rimozione |
| PATCH | `/api/cases/:id/confirm` | Segna la pratica come confermata |
| GET | `/api/cases/tasks/pending` | Lista verifiche in sospeso |
| PATCH | `/api/cases/:caseId/tasks/:taskId` | Registra esito di una verifica |
| POST | `/api/evidence/cases/:caseId` | Carica un file prova |
| GET | `/api/evidence/cases/:caseId` | Lista prove di una pratica |
| GET | `/api/evidence/:id/download` | Scarica un file prova |
| DELETE | `/api/evidence/:id` | Elimina un file prova |
| GET | `/api/export/csv` | Export CSV di tutte le pratiche |
| GET | `/api/export/pdf` | Export PDF di tutte le pratiche |
| GET | `/api/imap/status` | Stato del poller IMAP |
| POST | `/api/imap/poll` | Forza un polling IMAP manuale |

## Struttura del progetto

```
prisma/
  schema.prisma          — modello dati (SQLite)
src/
  index.ts               — entrypoint Express
  seed.ts                — ~22 broker pre-caricati (compilato in dist/seed.js)
  lib/prisma.ts          — singleton Prisma
  lib/enums.ts           — enum applicativi (SQLite non ha enum nativi)
  lib/serialize.ts       — array <-> JSON string (SQLite non ha array nativi)
  middleware/auth.ts     — autenticazione Bearer token
  routes/                — endpoint REST
  services/
    emailService.ts      — invio SMTP
    templateService.ts   — generazione testo richieste
    schedulerService.ts  — cron jobs (scadenze, verifiche, IMAP)
    imapService.ts       — parsing risposte email dei broker
  templates/             — GDPR Art.17, CCPA, opt-out generico
public/
  index.html             — dashboard SPA (vanilla JS)
evidence/                — storage locale file prova (volume Docker)
scripts/
  backup.sh              — backup DB cifrato (da adeguare a SQLite: copiare il file .db)
Caddyfile                — reverse proxy HTTPS (opzionale)
```

## Note sulla privacy

- Il campo `fullName` non è mai usato come chiave di ricerca verso i broker; viene esposto solo via endpoint dedicato, quando un broker lo richiede esplicitamente per processare la cancellazione.
- Il progetto non invia dati a servizi esterni; tutta la comunicazione avviene tramite SMTP/IMAP configurati dall'utente.
- Le prove caricate (email, screenshot) restano sul volume Docker locale.
