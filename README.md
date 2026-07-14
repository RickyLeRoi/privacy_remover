# Privacy Remover

> **Progetto personale — uso familiare**  
> Questo software è un progetto privato, scritto per uso personale e familiare.  
> **Non ha valore legale**, non sostituisce una consulenza legale e non è pensato per essere distribuito o usato da terzi.  
> Le richieste generate dal sistema sono tentativi informali di opt-out; l'effettiva cancellazione dai data broker dipende esclusivamente dalla loro politica interna.

Servizio self-hosted per tenere traccia delle richieste di rimozione dei dati personali dai principali data broker italiani e internazionali. Gira sulla rete privata di casa, senza esposizione pubblica.

## Funzionalità

- Dashboard web (dark/light) per gestire persone, broker e pratiche di rimozione
- Catalogo di **1885 broker** pre-caricati (registri USA + IAB Europe TCF), con triage per categoria
- **Verifica di presenza** manuale: prima di aprire una pratica si controlla se la persona compare davvero sul broker
- Generazione automatica delle richieste: GDPR Art. 17 (cancellazione), GDPR Art. 15 (accesso), CCPA, opt-out generico
- Tracciamento stato per ogni pratica: inviata → confermata → verifica periodica
- Azioni massive: apertura, invio e cancellazione di più pratiche insieme
- Caricamento prove (screenshot, email di risposta, PDF) per ogni caso
- Parser IMAP: legge automaticamente le risposte dei broker dalla casella email e aggiorna lo stato delle pratiche
- Export CSV e PDF dei casi
- Scheduler integrato: segnala pratiche scadute, pianifica verifiche a 90 giorni
- Containerizzato con Docker; database **SQLite** embedded (un solo container, nessun DB server esterno)

## Modello dati: una persona = una email

Ogni `Person` ha **una sola** email, ed è una chiave unica nel database.

Non è una limitazione tecnica ma una scelta di **minimizzazione** (GDPR Art. 5(1)(c)): la richiesta inviata al broker riporta l'email della persona, quindi tenere due indirizzi sullo stesso record significherebbe rivelare al broker un'email che magari non aveva mai avuto.

Se una persona fisica ha più email da ripulire, si creano **più `Person`**, una per email, distinguendole con l'etichetta:

```
Ricky privata   → ricky@gmail.com
Ricky lavoro    → ricky@azienda.it
```

Ognuna avrà le proprie pratiche, le proprie verifiche e le proprie scadenze. Provare a riusare la stessa email su due persone restituisce un errore `409`.

## Avvio rapido

La password **non si configura in un file**: al primo avvio la dashboard chiede di sceglierla.

```bash
cp .env.example .env
docker compose up -d

# Apri http://localhost:3000: al primo accesso la dashboard chiede di creare la
# password di amministratore (min 8 caratteri). Viene hashata (bcrypt) e salvata
# nel DB. Dagli accessi successivi la stessa schermata chiede semplicemente la
# password. Cambio password e reset si fanno dall'icona ingranaggio in basso a
# sinistra.

# (solo sviluppo locale, fuori Docker):
npm install
DATABASE_URL="file:./dev.db" npx prisma db push   # crea il DB SQLite
npm run db:seed                                    # carica i broker
npm run dev
```

## Comandi utili

### Aggiornare il catalogo dei broker

`src/data/brokers.json` è **generato**, ma è committato nel repo: `src/seed.ts` lo importa, quindi senza di lui `npm run build` non compila. Va rigenerato quando cambiano le fonti:

```bash
node scripts/build-brokers.js
```

Unisce tre fonti: `src/data/brokers-curated.json` (22 broker curati a mano), `Data_Broker_Full_Registry_2025.csv` (registri obbligatori di Vermont, Texas, California, Oregon — le email di privacy vengono da lì e **non vanno mai inventate**) e la IAB Europe TCF Global Vendor List, scaricata al volo.

Dopo aver rigenerato il file bisogna **alzare `BROKERS_VERSION`** in [src/seed.ts](src/seed.ts):

```ts
export const BROKERS_VERSION = "2026-07-14b";   // ← incrementare
```

Il seed confronta questa stringa con quella salvata nel DB e **si salta da solo** se coincidono. Se non la alzi, le installazioni esistenti non vedranno mai i nuovi broker, anche se il JSON è cambiato. Poi:

```bash
npm run db:seed        # in dev
node dist/seed.js      # in produzione (gira comunque a ogni avvio del container)
```

### Pubblicare / aggiornare l'immagine Docker su GitHub (GHCR)

L'immagine è pubblicata su GitHub Container Registry come `ghcr.io/rickyleroi/privacy_remover`, ed è quella che [docker-compose.vm.yml](docker-compose.vm.yml) scarica sulla VM. **Non serve nessun comando di publish**: ci pensa il workflow [.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml).

```bash
# Aggiornare :latest — basta pushare su main
git add -A && git commit -m "messaggio"
git push origin main

# Pubblicare anche una versione fissata (utile per tornare indietro sulla VM)
git tag v0.2.0
git push origin v0.2.0        # pubblica :v0.2.0 accanto a :latest
```

Il workflow costruisce per `linux/amd64` e `linux/arm64` (la build arm64 gira sotto QEMU ed è lenta: qualche minuto). Stato della build:

```bash
gh run list --limit 1
gh run watch <run-id>
```

**Una volta sola**, dopo la prima pubblicazione: i package su GHCR nascono **privati**, quindi il `docker pull` sulla VM fallisce con `denied`. O rendi il package pubblico (GitHub → Packages → `privacy_remover` → *Package settings* → *Change visibility*), oppure autentichi la VM:

```bash
echo $PAT | docker login ghcr.io -u RickyLeRoi --password-stdin   # PAT con scope read:packages
```

### Aggiornare la VM

```bash
docker compose -f docker-compose.vm.yml pull
docker compose -f docker-compose.vm.yml up -d
```

⚠️ L'entrypoint applica lo schema con `prisma db push --accept-data-loss`: se una release cambia lo schema in modo incompatibile, **i dati delle colonne rimosse vengono persi**. Il progetto non ha uno storico di migrazioni.

### Ricreare il database da zero

```bash
docker compose down -v && docker compose up -d --build     # locale
rm -f dev.db && DATABASE_URL="file:./dev.db" npx prisma db push && npm run db:seed
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

## Variabili d'ambiente

Sono già tutte scritte, con i loro default, dentro [docker-compose.vm.yml](docker-compose.vm.yml): **non serve compilarle tutte**. Quelle con un default sensato funzionano così come sono, e in pratica devi valorizzare solo i segreti (SMTP, IMAP, `BACKUP_PASSPHRASE`).

I segreti non vanno scritti nel compose, che finisce su git: mettili in un file `.env` accanto al compose e la sintassi `${VAR:-default}` li raccoglie da lì.

| Variabile | Default | A cosa serve |
|---|---|---|
| `DATABASE_URL` | `file:/app/data/app.db` | File SQLite. In Docker **deve** puntare al volume, altrimenti il DB muore col container. |
| `PORT` | `3000` | Porta di ascolto. |
| `NODE_ENV` | `production` | — |
| `TRUST_PROXY` | `0` | Quanti reverse proxy fidati ci sono davanti. **Lasciare 0** senza proxy: a 1 chiunque aggira il rate limit falsificando `X-Forwarded-For`. |
| `SEND_INTERVAL_MS` | `20000` | Intervallo fra due invii. Spedire centinaia di email di fila fa bloccare la casella. |
| `ADMIN_PASSWORD_HASH` | *(vuoto)* | **Solo per recupero.** La password si sceglie al primo avvio nella dashboard. Se valorizzata ha la precedenza sul DB. |
| `SMTP_HOST` | *(vuoto)* | Senza, l'app funziona ma non spedisce nulla. |
| `SMTP_PORT` | `587` | |
| `SMTP_USER` / `SMTP_PASS` | *(vuoti)* | Credenziali della casella che spedisce. |
| `SMTP_FROM` | *(vuoto)* | Mittente, es. `Privacy Bot <removal@dominio.it>`. |
| `IMAP_ENABLED` | `false` | A `true` legge le risposte dei broker e aggiorna le pratiche. |
| `IMAP_HOST` | *(vuoto)* | Se manca, il poller si salta da solo. |
| `IMAP_PORT` | `993` | |
| `IMAP_TLS` | `true` | |
| `IMAP_USER` / `IMAP_PASS` | *(vuoti)* | Credenziali della casella da leggere. |
| `IMAP_MAILBOX` | `INBOX` | |
| `BACKUP_PASSPHRASE` | *(vuoto)* | Cifratura dell'archivio di backup (AES-256). Senza, `backup.sh` si rifiuta di partire. |

## Backup

`scripts/backup.sh` produce un archivio cifrato con **database + prove** (le prove da sole non bastano: il DB le referenzia per path).

```bash
BACKUP_PASSPHRASE='passphrase-robusta' ./scripts/backup.sh
```

Usa `sqlite3 .backup`, che è transazionale: la copia è coerente anche con l'app che sta scrivendo (un `cp` a caldo può catturare pagine a metà transazione e produrre un file corrotto, di cui te ne accorgi solo il giorno del ripristino). Alla fine **rilegge l'archivio per verificare che si decifri**, e tiene 30 giorni di storico.

Ripristino:

```bash
BACKUP_PASSPHRASE='...' openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  -pass env:BACKUP_PASSPHRASE -in backups/backup_XXX.tar.gz.enc | tar -xzf - -C /tmp/restore
```

Poi rimetti `/tmp/restore/app.db` e `/tmp/restore/evidence/` al loro posto.

## API

Tutte le rotte sotto `/api` richiedono `Authorization: Bearer <password>`, **tranne** `/api/auth/status` e `/api/auth/setup` (che al primo avvio devono per forza essere pubbliche: la password non esiste ancora).

| Metodo | Path | Descrizione |
|--------|------|-------------|
| GET | `/api/auth/status` | Dice se la password è già stata impostata (pubblica) |
| POST | `/api/auth/setup` | Imposta la password al primo avvio (pubblica, risponde 409 se già configurata) |
| GET | `/api/auth/verify` | Valida la password con una sola richiesta (lo usa il login) |
| POST | `/api/auth/change-password` | Cambia la password |
| POST | `/api/auth/reset` | **Distruttivo**: cancella tutti i dati, azzera la password, riseminando i broker |
| GET | `/api/persons` | Lista persone (fullName omesso) |
| POST | `/api/persons` | Crea persona (409 se l'email è già usata) |
| GET | `/api/persons/:id` | Dettaglio persona (fullName omesso) |
| PUT | `/api/persons/:id` | Aggiorna persona (update parziale: i campi assenti non vengono toccati) |
| GET | `/api/persons/:id/response-identity` | Restituisce fullName (accesso esplicito, auditato) |
| GET | `/api/brokers` | Lista broker attivi |
| GET | `/api/brokers/categories` | Categorie di broker con relativi conteggi |
| GET | `/api/brokers/:id` | Dettaglio broker |
| POST | `/api/brokers` | Aggiunge broker |
| PATCH | `/api/brokers/:id` | Aggiorna broker |
| DELETE | `/api/brokers/:id` | Disattiva broker (soft delete) |
| GET | `/api/checks` | Broker su cui la presenza è verificabile, con esito e link di ricerca pronto |
| POST | `/api/checks` | Registra l'esito di una verifica (`found` / `not_found` / `unknown`) |
| GET | `/api/cases` | Lista pratiche |
| GET | `/api/cases/queue` | Coda di invio |
| POST | `/api/cases` | Apre una nuova pratica |
| POST | `/api/cases/bulk` | Apre più pratiche insieme |
| POST | `/api/cases/bulk-send` | Accoda l'invio di più pratiche |
| POST | `/api/cases/bulk-delete` | Cancella più pratiche insieme |
| POST | `/api/cases/:id/send` | Genera e invia la richiesta (Art. 17 o Art. 15 secondo `requestKind`) |
| PATCH | `/api/cases/:id/confirm` | Segna la pratica come confermata |
| GET | `/api/cases/tasks/pending` | Lista verifiche in sospeso |
| PATCH | `/api/cases/:caseId/tasks/:taskId` | Registra esito di una verifica |
| GET | `/api/messages/case/:caseId` | Messaggi inviati per una pratica |
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
.github/workflows/
  docker-publish.yml     — build multi-arch e push su GHCR
prisma/
  schema.prisma          — modello dati (SQLite)
src/
  index.ts               — entrypoint Express
  seed.ts                — semina il catalogo broker (compilato in dist/seed.js)
  data/
    brokers.json         — catalogo generato, 1885 broker (committato: seed.ts lo importa)
    brokers-curated.json — 22 broker curati a mano, sorgente del generatore
  lib/prisma.ts          — singleton Prisma
  lib/enums.ts           — enum applicativi (SQLite non ha enum nativi)
  lib/serialize.ts       — array <-> JSON string (SQLite non ha array nativi)
  lib/ids.ts             — id brevi e progressivi (P001, A001, B0001…)
  lib/asyncRouter.ts     — inoltra le rejection async all'error handler (Express 4 non lo fa)
  middleware/auth.ts     — autenticazione Bearer token
  routes/
    persons.ts           — anagrafica (una email per persona)
    brokers.ts           — catalogo e categorie
    checks.ts            — verifica di presenza manuale
    cases.ts             — pratiche, azioni massive, invio
    messages.ts evidence.ts export.ts imap.ts auth.ts
  services/
    emailService.ts      — invio SMTP
    sendQueueService.ts  — coda di invio (una email alla volta, per non farsi bloccare)
    templateService.ts   — generazione testo richieste
    schedulerService.ts  — cron jobs (scadenze, verifiche, IMAP)
    imapService.ts       — parsing risposte email dei broker
  templates/             — GDPR Art. 17, GDPR Art. 15, CCPA, opt-out generico
public/
  index.html             — dashboard SPA (vanilla JS)
evidence/                — storage locale file prova (volume Docker)
scripts/
  build-brokers.js       — genera src/data/brokers.json dalle fonti pubbliche
  backup.sh              — backup cifrato di DB + prove (SQLite)
Data_Broker_Full_Registry_2025.csv — registri USA, fonte del generatore
```

## Note sulla privacy

- Ogni `Person` ha **una sola email**: al broker non può mai arrivare un indirizzo che non stavi cercando su quel broker (vedi [Modello dati](#modello-dati-una-persona--una-email)).
- Il campo `fullName` non è mai usato come chiave di ricerca verso i broker e non compare in nessuna risposta di lista o dettaglio; viene esposto solo via endpoint dedicato, quando un broker lo richiede esplicitamente per processare la cancellazione.
- La verifica di presenza è **manuale**: nessuno scraping. I people-search lo vietano nei termini e lo bloccano con CAPTCHA; il sistema si limita a costruire il link di ricerca, guardare è compito dell'utente.
- Il progetto non invia dati a servizi esterni; tutta la comunicazione avviene tramite SMTP/IMAP configurati dall'utente.
- Le prove caricate (email, screenshot) restano sul volume Docker locale.
