import "dotenv/config";
import path from "path";
import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { personsRouter } from "./routes/persons";
import { brokersRouter } from "./routes/brokers";
import { casesRouter } from "./routes/cases";
import { messagesRouter } from "./routes/messages";
import { evidenceRouter } from "./routes/evidence";
import { exportRouter } from "./routes/export";
import { imapRouter } from "./routes/imap";
import { checksRouter } from "./routes/checks";
import { authRouter } from "./routes/auth";
import { authMiddleware } from "./middleware/auth";
import { initScheduler } from "./services/schedulerService";
import { startSendWorker } from "./services/sendQueueService";

function ts() { return new Date().toISOString(); }
export function log(tag: string, msg: string) { console.log(`${ts()} [${tag}] ${msg}`); }
export function logErr(tag: string, msg: string, err?: unknown) {
  console.error(`${ts()} [${tag}] ERROR ${msg}`, err ?? "");
}

log("startup", `Node ${process.version}  pid=${process.pid}`);
log("startup", `NODE_ENV=${process.env.NODE_ENV ?? "not set"}`);
log("startup", `DATABASE_URL=${(process.env.DATABASE_URL ?? "").replace(/:\/\/.*@/, "://<credentials>@")}`);
log("startup", `SMTP_HOST=${process.env.SMTP_HOST ?? "not set"}`);
log("startup", `IMAP_ENABLED=${process.env.IMAP_ENABLED ?? "not set"}  IMAP_HOST=${process.env.IMAP_HOST ?? "not set"}`);
log("startup", `ADMIN_PASSWORD_HASH=${process.env.ADMIN_PASSWORD_HASH ? "set (override env, ha la precedenza sul DB)" : "non impostata (si usa la password scelta al primo avvio)"}`);

const app = express();

// 20260715 RG - 0 = nessun proxy davanti: X-Forwarded-For arriva dal client e non va
// creduto, altrimenti il rate limit (e con esso la protezione dal brute force) si
// aggira falsificando l'header. Alzare a 1 solo aggiungendo un reverse proxy.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 0));

// 20260715 RG - La dashboard è inline e carica font e icone da due CDN: la CSP deve
// elencarli o la pagina resta bianca. Quei CDN vedono il tuo IP a ogni apertura:
// per un'app sulla privacy andrebbero serviti in locale.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
        // 20260717 RG - helmet (useDefaults) mette `script-src-attr 'none'`, che è una
        // direttiva a sé e NON è coperta da `'unsafe-inline'` di script-src: blocca gli
        // handler inline (onclick, onchange...). La UI in public/index.html ne usa ~46,
        // incluso il pulsante Salva delle Person, quindi senza questo i click non fanno
        // nulla. Coerente con l'unsafe-inline già accettato sopra per gli script inline.
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://api.fontshare.com"],
        fontSrc: ["'self'", "https://cdn.fontshare.com", "data:"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        // 20260716 RG - helmet con useDefaults (attivo) reinserisce di suo
        // `upgrade-insecure-requests`: quella direttiva forza ogni fetch da http a
        // https e, senza TLS sulla LAN/in Docker, le chiamate a /api falliscono con
        // "failed to fetch" mentre la pagina carica. La tolgo con null, coerente con
        // hsts:false qui sotto.
        upgradeInsecureRequests: null,
      },
    },
    // L'app gira anche in HTTP puro sulla LAN: HSTS bloccherebbe l'accesso.
    hsts: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json());

app.use((req: Request, _res: Response, next: NextFunction) => {
  log("http", `${req.method} ${req.path}`);
  next();
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// 20260715 RG - Il token Bearer È la password ed è verificata su OGNI rotta /api: il
// brute force non passa solo da /api/auth. Conta solo le richieste respinte, quindi
// non intralcia l'uso normale.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Troppi tentativi di autenticazione falliti. Riprova più tardi." },
});

// 20260701 RG - Static prima dell'auth: serve per raggiungere la pagina di login,
// ma significa anche che tutto ciò che sta in public/ è accessibile senza token.
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => {
  log("health", "ping");
  res.json({ ok: true, ts: new Date().toISOString() });
});

// 20260701 RG - Deve stare prima di authMiddleware: /status e /setup girano senza
// password (al primo avvio non ne esiste ancora una). Le rotte distruttive dentro
// authRouter applicano l'auth per conto proprio.
app.use("/api/auth", authLimiter, authRouter);

app.use("/api", authLimiter, authMiddleware);
app.use("/api/persons",  personsRouter);
app.use("/api/brokers",  brokersRouter);
app.use("/api/cases",    casesRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/evidence", evidenceRouter);
app.use("/api/export",   exportRouter);
app.use("/api/imap",     imapRouter);
app.use("/api/checks",   checksRouter);

// 20260715 RG - Dopo i router e prima del catch-all: senza, una rotta /api inesistente
// tornava 200 + index.html, e la SPA falliva con un errore di parsing invece di un 404.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Endpoint non trovato" });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// 20260701 RG - Deve restare l'ultimo middleware registrato: Express riconosce
// l'error handler dalla firma a 4 argomenti e lo invoca solo se viene dopo le
// rotte che possono fallire.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  logErr("express", `Unhandled error on ${req.method} ${req.path}`, err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, "0.0.0.0", async () => {
  log("startup", `Privacy Remover listening on http://0.0.0.0:${PORT}`);
  await initScheduler();
  startSendWorker();
});

process.on("unhandledRejection", (reason) => {
  logErr("process", "Unhandled promise rejection", reason);
});
process.on("uncaughtException", (err) => {
  logErr("process", "Uncaught exception — shutting down", err);
  process.exit(1);
});
