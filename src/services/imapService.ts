import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { CaseStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { log, logErr } from "../index";

// ─── Keyword patterns that signal a confirmed removal ────────────────────────
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

// Patterns that signal the broker denied or needs more info
const DENIED_PATTERNS = [
  /unable to process/i,
  /cannot be processed/i,
  /denied/i,
  /negat/i,
  /additional information required/i,
  /verification required/i,
  /non (?:possiamo|è possibile)/i,
];

// ─── Classify an email body ───────────────────────────────────────────────────
function classify(subject: string, body: string | false): "confirmed" | "denied" | "unknown" {
  const text = `${subject} ${body}`;
  if (CONFIRMED_PATTERNS.some((r) => r.test(text))) return "confirmed";
  if (DENIED_PATTERNS.some((r) => r.test(text))) return "denied";
  return "unknown";
}

// ─── Match an inbound email to an open case ───────────────────────────────────
// Strategy: find cases in SENT/AWAITING_RESPONSE status whose broker
// contactTarget (email) matches the From address of the inbound email.
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

// ─── Process a single parsed message ─────────────────────────────────────────
async function processMessage(parsed: Awaited<ReturnType<typeof simpleParser>>) {
  const from = parsed.from?.value?.[0]?.address ?? "";
  const subject = parsed.subject ?? "";
  const body = parsed.text ?? parsed.html ?? "";

  if (!from) return;

  const matchedCases = await matchCase(from);
  if (!matchedCases.length) return;

  const verdict = classify(subject, body);
  log("imap", `from=${from} | subject="${subject.slice(0, 60)}" → ${verdict} | ${matchedCases.length} case(s)`);

  for (const c of matchedCases) {
    // Save the inbound email as Evidence regardless of verdict
    await prisma.evidence.create({
      data: {
        caseId: c.id,
        type: "broker_response",
        filePath: `imap-${c.id}-${Date.now()}.txt`,
        checksum: Buffer.from(`${from}|${subject}|${Date.now()}`).toString("base64"),
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
      // Unknown — flag for manual review
      await prisma.removalCase.update({
        where: { id: c.id },
        data: { status: CaseStatus.AWAITING_RESPONSE },
      });
      log("imap", `case ${c.id} → AWAITING_RESPONSE (manual review needed)`);
    }
  }
}

// ─── Main polling function ────────────────────────────────────────────────────
export async function pollInbox() {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  const port = Number(process.env.IMAP_PORT ?? 993);
  const tls  = process.env.IMAP_TLS !== "false";

  if (!host || !user || !pass) {
    log("imap", "IMAP_HOST / IMAP_USER / IMAP_PASS not configured — skipping poll");
    return;
  }

  log("imap", `connecting to ${host}:${port} tls=${tls} user=${user}`);

  const client = new ImapFlow({
    host,
    port,
    secure: tls,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
    log("imap", "connected, fetching UNSEEN messages");
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Fetch only UNSEEN messages to avoid re-processing
      for await (const message of client.fetch("1:*", { source: true }, { uid: true })) {
        if (!message.source) continue;
        const parsed = await (simpleParser as (source: Buffer) => Promise<import("mailparser").ParsedMail>)(message.source);
        await processMessage(parsed);
        // Mark as Seen so we don't re-process on next poll
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
