import "dotenv/config";
import path from "path";
import express, { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { personsRouter } from "./routes/persons";
import { brokersRouter } from "./routes/brokers";
import { casesRouter } from "./routes/cases";
import { messagesRouter } from "./routes/messages";
import { evidenceRouter } from "./routes/evidence";
import { exportRouter } from "./routes/export";
import { imapRouter } from "./routes/imap";
import { authMiddleware } from "./middleware/auth";
import { initScheduler } from "./services/schedulerService";

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
log("startup", `ADMIN_PASSWORD_HASH=${process.env.ADMIN_PASSWORD_HASH ? "set" : "NOT SET — all API calls will fail"}`);

const app = express();
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

// 20260701 RG - Static prima dell'auth: serve per raggiungere la pagina di login,
// ma significa anche che tutto ciò che sta in public/ è accessibile senza token.
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => {
  log("health", "ping");
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use("/api", authMiddleware);
app.use("/api/persons",  personsRouter);
app.use("/api/brokers",  brokersRouter);
app.use("/api/cases",    casesRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/evidence", evidenceRouter);
app.use("/api/export",   exportRouter);
app.use("/api/imap",     imapRouter);

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
});

process.on("unhandledRejection", (reason) => {
  logErr("process", "Unhandled promise rejection", reason);
});
process.on("uncaughtException", (err) => {
  logErr("process", "Uncaught exception — shutting down", err);
  process.exit(1);
});
