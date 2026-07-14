import { Router } from "express";
import { z } from "zod";
import { addDays } from "date-fns";
import fs from "fs";
import path from "path";
import { CaseStatus, PresenceResult, VerificationResult } from "../lib/enums";
import { EVIDENCE_DIR } from "../lib/evidenceStore";
import { nextId, nextIds } from "../lib/ids";
import { prisma } from "../lib/prisma";
import { packList } from "../lib/serialize";
import { generateMessage } from "../services/templateService";
import { sendEmail } from "../services/emailService";
import { queueDepth, queueStats } from "../services/sendQueueService";
import { logErr } from "../index";

export const casesRouter = Router();

const OpenSchema = z.object({ personId: z.string(), brokerId: z.string() });

casesRouter.post("/", async (req, res) => {
  const parsed = OpenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);
  const { personId, brokerId } = parsed.data;

  const broker = await prisma.broker.findUnique({ where: { id: brokerId } });
  if (!broker) return res.status(404).json({ error: "Broker not found" });

  const c = await prisma.removalCase.create({
    data: {
      id: await nextId("case"),
      personId,
      brokerId,
      status: CaseStatus.NOT_STARTED,
      dueAt: addDays(new Date(), broker.slaInDays),
    },
  });
  res.status(201).json(c);
});

// 20260701 RG - Apre in un colpo solo una pratica per ogni broker attivo su cui la
// persona non ne ha già una. NON invia nulla: le pratiche restano NOT_STARTED e
// l'invio resta una scelta esplicita. Con ~1900 broker, inviare in automatico
// significherebbe centinaia di email dalla stessa casella e il blocco dell'SMTP.
const BulkSchema = z.object({
  personId: z.string(),
  contactMethod: z.enum(["email", "form", "api"]).optional(),
  country: z.string().optional(),
  categories: z.array(z.string()).optional(),
  // Apre solo dove la verifica manuale ha dato "trovato".
  onlyFound: z.boolean().optional(),
  requestKind: z.enum(["erasure", "access"]).optional(),
});

casesRouter.post("/bulk", async (req, res) => {
  const parsed = BulkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);
  const { personId, contactMethod, country, categories, onlyFound, requestKind } = parsed.data;

  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) return res.status(404).json({ error: "Person not found" });

  const brokers = await prisma.broker.findMany({
    where: {
      active: true,
      ...(contactMethod ? { contactMethod } : {}),
      ...(country ? { country } : {}),
      ...(categories?.length ? { category: { in: categories } } : {}),
    },
    select: { id: true, slaInDays: true },
  });

  let candidates = brokers;
  if (onlyFound) {
    const found = new Set(
      (await prisma.presenceCheck.findMany({
        where: { personId, result: PresenceResult.found },
        select: { brokerId: true },
      })).map((c) => c.brokerId)
    );
    candidates = brokers.filter((b) => found.has(b.id));
  }

  const already = new Set(
    (await prisma.removalCase.findMany({ where: { personId }, select: { brokerId: true } }))
      .map((c) => c.brokerId)
  );

  const toOpen = candidates.filter((b) => !already.has(b.id));
  const now = new Date();
  const ids = await nextIds("case", toOpen.length);

  const CHUNK = 200;
  for (let i = 0; i < toOpen.length; i += CHUNK) {
    await prisma.removalCase.createMany({
      data: toOpen.slice(i, i + CHUNK).map((b, j) => ({
        id: ids[i + j],
        personId,
        brokerId: b.id,
        status: CaseStatus.NOT_STARTED,
        requestKind: requestKind ?? "erasure",
        dueAt: addDays(now, b.slaInDays),
      })),
    });
  }

  res.status(201).json({
    created: toOpen.length,
    skipped: candidates.length - toOpen.length,
    total: candidates.length,
  });
});

// 20260701 RG - Invio massivo: NON spedisce qui dentro. Mette le pratiche email in
// coda (il worker le manda una ogni SEND_INTERVAL_MS) e chiude subito la richiesta.
// Una risposta HTTP non può restare aperta le ore che servono a 700 invii.
const IdsSchema = z.object({ caseIds: z.array(z.string()).min(1) });

casesRouter.post("/bulk-send", async (req, res) => {
  const parsed = IdsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const cases = await prisma.removalCase.findMany({
    where: { id: { in: parsed.data.caseIds } },
    include: { broker: { select: { contactMethod: true } } },
  });

  const sendable = cases.filter((c) =>
    c.status === CaseStatus.NOT_STARTED || c.status === CaseStatus.FAILED
  );
  const email = sendable.filter((c) => c.broker.contactMethod === "email");
  const manual = sendable.filter((c) => c.broker.contactMethod !== "email");

  if (email.length) {
    await prisma.removalCase.updateMany({
      where: { id: { in: email.map((c) => c.id) } },
      data: { status: CaseStatus.QUEUED },
    });
  }

  res.status(202).json({
    queued: email.length,
    // I broker senza email non si possono spedire: vanno compilati a mano sul loro form.
    manualOnly: manual.length,
    skipped: cases.length - sendable.length,
    queueDepth: await queueDepth(),
  });
});

casesRouter.post("/bulk-delete", async (req, res) => {
  const parsed = IdsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);
  const caseIds = parsed.data.caseIds;

  // 20260701 RG - I file delle prove vanno tolti dal disco: cancellare solo la riga
  // lascerebbe il volume pieno di allegati orfani.
  const evidence = await prisma.evidence.findMany({
    where: { caseId: { in: caseIds } },
    select: { filePath: true },
  });
  for (const e of evidence) {
    const abs = path.join(EVIDENCE_DIR, e.filePath);
    if (fs.existsSync(abs)) {
      try { fs.unlinkSync(abs); } catch { /* già rimosso */ }
    }
  }

  // Ordine imposto dalle foreign key.
  await prisma.verificationTask.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.evidence.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.outboundMessage.deleteMany({ where: { caseId: { in: caseIds } } });
  const del = await prisma.removalCase.deleteMany({ where: { id: { in: caseIds } } });

  res.json({ deleted: del.count });
});

casesRouter.get("/queue", async (_req, res) => {
  res.json({ ...queueStats(), depth: await queueDepth() });
});

casesRouter.get("/", async (req, res) => {
  const cases = await prisma.removalCase.findMany({
    include: {
      person:  { select: { id: true, label: true } },
      broker:  { select: { id: true, name: true, slaInDays: true } },
      messages: { select: { id: true, sentAt: true } },
    },
    orderBy: { openedAt: "desc" },
  });
  res.json(cases);
});

casesRouter.post("/:id/send", async (req, res) => {
  const c = await prisma.removalCase.findUnique({
    where: { id: req.params.id },
    include: { person: { include: { addresses: true } }, broker: true },
  });
  if (!c) return res.status(404).json({ error: "Not found" });

  const kind = c.requestKind === "access" ? "access" : "erasure";
  const { subject, body, discoveryKeysUsed, templateKey } = generateMessage(c.person, c.broker, kind);

  // 20260701 RG - Express 4 non intercetta le rejection async: senza questo catch
  // un errore SMTP lascerebbe la richiesta appesa. Si esce prima di creare il
  // messaggio, così la pratica non risulta inviata quando non lo è.
  let providerMsgId: string | undefined;
  if (c.broker.contactMethod === "email") {
    try {
      providerMsgId = await sendEmail({
        to: c.broker.contactTarget,
        subject,
        text: body,
      });
    } catch (err) {
      logErr("cases", `SMTP send failed for case ${c.id}`, err);
      return res.status(502).json({ error: "Invio email fallito", detail: String(err) });
    }
  }

  const msg = await prisma.outboundMessage.create({
    data: {
      id: await nextId("message"),
      caseId: c.id,
      channel: c.broker.contactMethod === "email" ? "email" : "form_manual",
      templateKey,
      discoveryKeysUsed: packList(discoveryKeysUsed),
      fullNameIncluded: false,
      sentAt: c.broker.contactMethod === "email" ? new Date() : null,
      providerMsgId,
      raw: body,
    },
  });

  await prisma.removalCase.update({
    where: { id: c.id },
    data: { status: kind === "access" ? CaseStatus.ACCESS_SENT : CaseStatus.SENT },
  });

  res.json({ caseId: c.id, messageId: msg.id, channel: msg.channel });
});

casesRouter.patch("/:id/confirm", async (req, res) => {
  const existing = await prisma.removalCase.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });

  const c = await prisma.removalCase.update({
    where: { id: req.params.id },
    data: {
      status: CaseStatus.CONFIRMED,
      closedAt: new Date(),
      nextCheckAt: addDays(new Date(), 90),
    },
  });
  res.json(c);
});

casesRouter.get("/tasks/pending", async (_req, res) => {
  const tasks = await prisma.verificationTask.findMany({
    where: { executedAt: null },
    include: {
      case: {
        include: {
          person: { select: { id: true, label: true } },
          broker: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { scheduledFor: "asc" },
  });
  res.json(tasks);
});

const TaskResultSchema = z.object({
  result: z.enum(["removed", "still_present", "error"]),
  notes: z.string().optional(),
});

casesRouter.patch("/:caseId/tasks/:taskId", async (req, res) => {
  const parsed = TaskResultSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const task = await prisma.verificationTask.findFirst({
    where: { id: req.params.taskId, caseId: req.params.caseId },
  });
  if (!task) return res.status(404).json({ error: "Task not found" });

  const updated = await prisma.verificationTask.update({
    where: { id: req.params.taskId },
    data: {
      executedAt: new Date(),
      result: parsed.data.result as VerificationResult,
      notes: parsed.data.notes,
    },
  });

  if (parsed.data.result === "removed") {
    await prisma.removalCase.update({
      where: { id: req.params.caseId },
      data: { status: CaseStatus.CONFIRMED, closedAt: new Date() },
    });
  } else if (parsed.data.result === "still_present") {
    await prisma.removalCase.update({
      where: { id: req.params.caseId },
      data: { status: CaseStatus.NEEDS_RECHECK },
    });
  }

  res.json(updated);
});
