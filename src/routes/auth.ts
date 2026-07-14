import { Router } from "express";
import { z } from "zod";
import {
  MIN_PASSWORD_LENGTH,
  clearPassword,
  isConfigured,
  setPassword,
  verifyPassword,
} from "../lib/adminPassword";
import { resetSequences } from "../lib/ids";
import { prisma } from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";
import { seedBrokers } from "../seed";
import { log } from "../index";

export const authRouter = Router();

const PasswordSchema = z.string().min(MIN_PASSWORD_LENGTH, `Minimo ${MIN_PASSWORD_LENGTH} caratteri`);

// Pubblica: la dashboard la interroga al caricamento per decidere se mostrare la
// schermata di primo avvio o quella di login.
authRouter.get("/status", async (_req, res) => {
  res.json({ configured: await isConfigured() });
});

// 20260701 RG - Pubblica per forza: al primo avvio non esiste ancora una password
// con cui autenticarsi. È protetta solo dal fatto di funzionare una volta sola:
// appena la password esiste, risponde 409. Chi raggiunge per primo un'istanza
// appena creata la rivendica — accettabile in LAN, non esporre la porta prima
// di aver completato il setup.
authRouter.post("/setup", async (req, res) => {
  if (await isConfigured()) {
    return res.status(409).json({ error: "Password già impostata" });
  }

  const parsed = PasswordSchema.safeParse(req.body?.password);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  await setPassword(parsed.data);
  log("auth", "SETUP: password impostata al primo avvio");
  res.status(201).json({ ok: true });
});

authRouter.post("/change-password", authMiddleware, async (req, res) => {
  const current = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
  if (!(await verifyPassword(current))) {
    return res.status(401).json({ error: "Password attuale errata" });
  }

  const parsed = PasswordSchema.safeParse(req.body?.newPassword);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  await setPassword(parsed.data);
  log("auth", "password cambiata");
  res.json({ ok: true });
});

// 20260701 RG - Distruttivo: cancella persone, pratiche, messaggi, prove e task,
// azzera la password e riporta i broker alla lista predefinita. Richiede la password
// attuale, così un tab lasciato aperto non basta a innescarlo.
authRouter.post("/reset", authMiddleware, async (req, res) => {
  const current = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
  if (!(await verifyPassword(current))) {
    return res.status(401).json({ error: "Password errata" });
  }

  // Ordine imposto dalle foreign key.
  await prisma.verificationTask.deleteMany();
  await prisma.evidence.deleteMany();
  await prisma.outboundMessage.deleteMany();
  await prisma.removalCase.deleteMany();
  await prisma.address.deleteMany();
  await prisma.person.deleteMany();
  await prisma.broker.deleteMany();

  // 20260701 RG - Azzerare i contatori PRIMA di riseminare: altrimenti i broker
  // ricreati ripartirebbero da B1915 invece che da B0001.
  await resetSequences();

  const brokers = await seedBrokers();
  await clearPassword();

  log("auth", `RESET: dati cancellati, ${brokers} broker ripristinati, password azzerata`);
  res.json({ ok: true, brokers });
});
