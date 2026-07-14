import { Router } from "express";
import { z } from "zod";
import { addDays } from "date-fns";
import { CaseStatus, VerificationResult } from "../lib/enums";
import { nextId, nextIds } from "../lib/ids";
import { prisma } from "../lib/prisma";
import { packList } from "../lib/serialize";
import { generateMessage } from "../services/templateService";
import { sendEmail } from "../services/emailService";
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
});

casesRouter.post("/bulk", async (req, res) => {
  const parsed = BulkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);
  const { personId, contactMethod, country } = parsed.data;

  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) return res.status(404).json({ error: "Person not found" });

  const brokers = await prisma.broker.findMany({
    where: {
      active: true,
      ...(contactMethod ? { contactMethod } : {}),
      ...(country ? { country } : {}),
    },
    select: { id: true, slaInDays: true },
  });

  const already = new Set(
    (await prisma.removalCase.findMany({ where: { personId }, select: { brokerId: true } }))
      .map((c) => c.brokerId)
  );

  const toOpen = brokers.filter((b) => !already.has(b.id));
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
        dueAt: addDays(now, b.slaInDays),
      })),
    });
  }

  res.status(201).json({
    created: toOpen.length,
    skipped: brokers.length - toOpen.length,
    total: brokers.length,
  });
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

  const { subject, body, discoveryKeysUsed } = generateMessage(c.person, c.broker);

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
      templateKey: `${c.broker.legalBasis}_erasure_v1`,
      discoveryKeysUsed: packList(discoveryKeysUsed),
      fullNameIncluded: false,
      sentAt: c.broker.contactMethod === "email" ? new Date() : null,
      providerMsgId,
      raw: body,
    },
  });

  await prisma.removalCase.update({
    where: { id: c.id },
    data: { status: CaseStatus.SENT },
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
