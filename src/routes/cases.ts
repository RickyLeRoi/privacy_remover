import { Router } from "express";
import { z } from "zod";
import { addDays } from "date-fns";
import { CaseStatus, VerificationResult } from "../lib/enums";
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
      personId,
      brokerId,
      status: CaseStatus.NOT_STARTED,
      dueAt: addDays(new Date(), broker.slaInDays),
    },
  });
  res.status(201).json(c);
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
