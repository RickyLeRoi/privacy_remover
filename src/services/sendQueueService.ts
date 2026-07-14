import { CaseStatus } from "../lib/enums";
import { nextId } from "../lib/ids";
import { prisma } from "../lib/prisma";
import { packList } from "../lib/serialize";
import { sendEmail } from "./emailService";
import { generateMessage, RequestKind } from "./templateService";
import { log, logErr } from "../index";

// 20260701 RG - Spedire centinaia di email in pochi minuti dalla stessa casella
// significa farsi bloccare o marcare come spam dal provider. Qui si invia UNA email
// ogni SEND_INTERVAL_MS. Lo stato della coda è a DB (CaseStatus.QUEUED), non in
// memoria: una coda da 700 invii dura ore e deve sopravvivere al riavvio del
// container.
const INTERVAL_MS = Number(process.env.SEND_INTERVAL_MS ?? 20_000);

let running = false;
let stats = { sent: 0, failed: 0, lastError: null as string | null, lastSentAt: null as Date | null };

export function queueStats() {
  return { ...stats, intervalMs: INTERVAL_MS, running };
}

export async function queueDepth(): Promise<number> {
  return prisma.removalCase.count({ where: { status: CaseStatus.QUEUED } });
}

async function sendOne(caseId: string): Promise<void> {
  const c = await prisma.removalCase.findUnique({
    where: { id: caseId },
    include: { person: { include: { addresses: true } }, broker: true },
  });
  if (!c) return;

  const kind = (c.requestKind === "access" ? "access" : "erasure") as RequestKind;
  const { subject, body, discoveryKeysUsed, templateKey } = generateMessage(c.person, c.broker, kind);

  let providerMsgId: string | undefined;
  try {
    providerMsgId = await sendEmail({ to: c.broker.contactTarget, subject, text: body });
  } catch (err) {
    // 20260701 RG - Un invio fallito NON deve bloccare la coda: la pratica va in
    // FAILED e si prosegue. Altrimenti un broker con indirizzo morto fermerebbe tutto.
    stats.failed++;
    stats.lastError = String(err);
    logErr("queue", `invio fallito per ${caseId} (${c.broker.name})`, err);
    await prisma.removalCase.update({ where: { id: caseId }, data: { status: CaseStatus.FAILED } });
    return;
  }

  await prisma.outboundMessage.create({
    data: {
      id: await nextId("message"),
      caseId: c.id,
      channel: "email",
      templateKey,
      discoveryKeysUsed: packList(discoveryKeysUsed),
      fullNameIncluded: false,
      sentAt: new Date(),
      providerMsgId,
      raw: body,
    },
  });

  await prisma.removalCase.update({
    where: { id: c.id },
    data: { status: kind === "access" ? CaseStatus.ACCESS_SENT : CaseStatus.SENT },
  });

  stats.sent++;
  stats.lastSentAt = new Date();
  stats.lastError = null;
  log("queue", `inviata ${c.id} -> ${c.broker.name} (${kind})`);
}

export function startSendWorker(): void {
  if (running) return;
  running = true;
  log("queue", `worker avviato — un invio ogni ${INTERVAL_MS / 1000}s`);

  const tick = async () => {
    try {
      const next = await prisma.removalCase.findFirst({
        where: { status: CaseStatus.QUEUED },
        orderBy: { openedAt: "asc" },
        select: { id: true },
      });
      if (next) await sendOne(next.id);
    } catch (err) {
      logErr("queue", "errore nel worker", err);
    } finally {
      setTimeout(tick, INTERVAL_MS);
    }
  };

  setTimeout(tick, 2_000);
}
