import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { CaseStatus, EvidenceType } from "../lib/enums";
import { prisma } from "../lib/prisma";
import { writeEvidenceFile } from "../lib/evidenceStore";
import { log, logErr } from "../index";

const CONFIRMED_PATTERNS = [
  /removed?/i,
  /deleted?/i,
  /erasure.{0,20}complet/i,
  /opt.?out.{0,20}confirmed/i,
  /rimoss[oa]/i,
  /cancellat[oa]/i,
  /request.{0,30}processed/i,
  /has been processed/i,
  /successfully removed/i,
  /opt-out confirmed/i,
  /conferm/i,
];

const DENIED_PATTERNS = [
  /unable to process/i,
  /cannot be processed/i,
  /denied/i,
  /negat/i,
  /additional information required/i,
  /verification required/i,
  /non (?:possiamo|è possibile)/i,
];

// 20260701 RG - La classificazione è solo euristica su keyword: "removed" compare
// anche in frasi negative ("cannot be removed"), quindi può chiudere una pratica
// che invece è stata rifiutata. Verificare sempre a mano prima di fidarsi.
function classify(subject: string, body: string | false): "confirmed" | "denied" | "unknown" {
  const text = `${subject} ${body}`;
  if (CONFIRMED_PATTERNS.some((r) => r.test(text))) return "confirmed";
  if (DENIED_PATTERNS.some((r) => r.test(text))) return "denied";
  return "unknown";
}

// 20260701 RG - L'abbinamento avviene solo per uguaglianza esatta tra il mittente
// e broker.contactTarget: se il broker risponde da un indirizzo diverso (noreply,
// ticketing) la risposta non viene associata a nessuna pratica.
async function matchCase(fromAddress: string) {
  const cases = await prisma.removalCase.findMany({
    where: {
      status: { in: [CaseStatus.SENT, CaseStatus.AWAITING_RESPONSE] },
    },
    include: {
      broker: { select: { contactTarget: true, contactMethod: true } },
    },
  });

  return cases.filter(
    (c) =>
      c.broker.contactMethod === "email" &&
      c.broker.contactTarget.toLowerCase().trim() === fromAddress.toLowerCase().trim()
  );
}

async function processMessage(parsed: Awaited<ReturnType<typeof simpleParser>>) {
  const from = parsed.from?.value?.[0]?.address ?? "";
  const subject = parsed.subject ?? "";
  // 20260701 RG - parsed.html è `string | false`: senza questa normalizzazione il
  // valore `false` finirebbe stringificato dentro la prova salvata.
  const body = parsed.text ?? (typeof parsed.html === "string" ? parsed.html : "");

  if (!from) return;

  const matchedCases = await matchCase(from);
  if (!matchedCases.length) return;

  const verdict = classify(subject, body);
  log("imap", `from=${from} | subject="${subject.slice(0, 60)}" → ${verdict} | ${matchedCases.length} case(s)`);

  for (const c of matchedCases) {
    const stored = writeEvidenceFile(
      `imap-${c.id}-${Date.now()}.txt`,
      `From: ${from}\nSubject: ${subject}\nDate: ${new Date().toISOString()}\n\n${body}`
    );
    await prisma.evidence.create({
      data: {
        caseId: c.id,
        type: EvidenceType.broker_response,
        filePath: stored.filePath,
        checksum: stored.checksum,
        encrypted: false,
      },
    });

    if (verdict === "confirmed") {
      await prisma.removalCase.update({
        where: { id: c.id },
        data: {
          status: CaseStatus.CONFIRMED,
          closedAt: new Date(),
        },
      });
      log("imap", `case ${c.id} → CONFIRMED`);
    } else if (verdict === "denied") {
      await prisma.removalCase.update({
        where: { id: c.id },
        data: { status: CaseStatus.NEEDS_RECHECK },
      });
      log("imap", `case ${c.id} → NEEDS_RECHECK (denied)`);
    } else {
      await prisma.removalCase.update({
        where: { id: c.id },
        data: { status: CaseStatus.AWAITING_RESPONSE },
      });
      log("imap", `case ${c.id} → AWAITING_RESPONSE (manual review needed)`);
    }
  }
}

export async function pollInbox() {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  const port = Number(process.env.IMAP_PORT ?? 993);
  const tls  = process.env.IMAP_TLS !== "false";
  const mailbox = process.env.IMAP_MAILBOX || "INBOX";

  if (!host || !user || !pass) {
    log("imap", "IMAP_HOST / IMAP_USER / IMAP_PASS not configured — skipping poll");
    return;
  }

  log("imap", `connecting to ${host}:${port} tls=${tls} user=${user} mailbox=${mailbox}`);

  const client = new ImapFlow({
    host,
    port,
    secure: tls,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    try {
      // 20260701 RG - Elaborare solo i non letti è ciò che rende il poll idempotente:
      // insieme al flag \Seen impostato sotto, evita di rigenerare prove e riscrivere
      // gli stati delle pratiche a ogni giro.
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) {
        log("imap", `no unseen messages in ${mailbox}`);
        return;
      }
      log("imap", `${uids.length} unseen message(s) in ${mailbox}`);

      for await (const message of client.fetch(uids, { source: true }, { uid: true })) {
        if (!message.source) continue;
        const parsed = await (simpleParser as (source: Buffer) => Promise<import("mailparser").ParsedMail>)(message.source);
        await processMessage(parsed);
        await client.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    logErr("imap", "poll error", err);
  } finally {
    await client.logout();
  }
}
