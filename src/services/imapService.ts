import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { CaseStatus, EvidenceType } from "../lib/enums";
import { nextId } from "../lib/ids";
import { prisma } from "../lib/prisma";
import { writeEvidenceFile } from "../lib/evidenceStore";
import { log, logErr } from "../index";

// 20260715 RG - Le conferme devono essere frasi complete al participio ("has been
// removed", "abbiamo cancellato"). Prima bastavano /removed?/ e /deleted?/, che
// matchano anche "remove" e "delete" da sole: un "we cannot remove your data" — o un
// auto-reply che citava la NOSTRA richiesta, che contiene "delete all personal data" —
// chiudeva la pratica come CONFIRMED.
const CONFIRMED_PATTERNS = [
  /(?:has|have) been (?:permanently |successfully )?(?:removed|deleted|erased|suppressed)/i,
  /(?:we|i) (?:have )?(?:removed|deleted|erased)\b/i,
  /successfully (?:removed|deleted|erased|processed)/i,
  /erasure.{0,20}(?:complet|fulfil)/i,
  /opt.?out.{0,20}(?:confirmed|complet)/i,
  /(?:your|the) request.{0,30}(?:has been )?(?:completed|fulfilled)/i,
  /(?:sono|sono stati|è stato) (?:rimoss|cancellat|eliminat)[oiae]/i,
  /(?:abbiamo|ho) (?:rimosso|cancellato|eliminato)/i,
  /(?:dati|dato).{0,30}(?:rimoss|cancellat|eliminat)[oiae]/i,
];

// 20260715 RG - Testati PRIMA delle conferme: un rifiuto contiene quasi sempre anche il
// verbo della conferma ("your data cannot be removed"). Vanno tenuti larghi: un falso
// rifiuto costa una verifica in più, una falsa conferma chiude la pratica lasciando i
// dati online.
const DENIED_PATTERNS = [
  /(?:cannot|can not|can't|could not|couldn't|unable to|won't|will not)\s+(?:be\s+)?(?:process|remove|delete|erase|comply|fulfil)/i,
  /not (?:be )?(?:removed|deleted|erased|processed)/i,
  /unable to process/i,
  /denied|rejected|refus/i,
  /negat|rifiut/i,
  /(?:additional|further) (?:information|documentation)\s+(?:is )?(?:required|needed)/i,
  /(?:identity|verification|proof of identity|government[- ]issued)\s*(?:document|id)?\s*(?:is )?(?:required|needed)/i,
  /verification required/i,
  /non (?:possiamo|è possibile|possono)/i,
  /(?:documento|carta d'identità).{0,30}(?:necessari|richiest)/i,
];

// La risposta tipica a una richiesta di accesso (Art.15) quando il broker non ti ha:
// niente da cancellare, la pratica si chiude come NO_DATA.
const NO_DATA_PATTERNS = [
  /do not (?:hold|have|process|possess).{0,40}(?:personal )?(?:data|information)/i,
  /no (?:personal )?(?:data|information|records?).{0,30}(?:found|held|on file|about you)/i,
  /not (?:hold|have).{0,30}records?/i,
  /non (?:trattiamo|deteniamo|possediamo|disponiamo).{0,40}dat/i,
  /nessun dato/i,
  /no match(?:es)? (?:were )?found/i,
];

// 20260715 RG - Gli helpdesk rispondono citando il messaggio originale, che contiene
// "permanently delete all personal data": senza tagliarlo si finisce per classificare
// le parole della NOSTRA richiesta scambiandole per la risposta del broker.
const QUOTE_MARKERS = [
  /^-{2,}\s*original message\s*-{2,}/im,
  /^_{5,}/m,
  /^on .{0,80}\bwrote:/im,
  /^il giorno .{0,80}\bha scritto:/im,
  /^from:\s.+$/im,
  /^da:\s.+$/im,
  /your (?:original )?(?:message|request)(?: was)?:/i,
  /messaggio originale:/i,
];

export function stripQuotedText(body: string): string {
  let text = body;

  // Taglia dal primo marcatore di citazione in poi.
  for (const marker of QUOTE_MARKERS) {
    const m = text.match(marker);
    if (m && m.index !== undefined) text = text.slice(0, m.index);
  }

  // Righe che iniziano con ">" sono citazione riga per riga.
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

// 20260715 RG - L'ordine è la parte critica: no_data → denied → confirmed. La conferma
// è l'unico verdetto che chiude la pratica, quindi va riconosciuta per ultima e con i
// criteri più stretti.
export function classify(
  subject: string,
  body: string | false
): "no_data" | "confirmed" | "denied" | "unknown" {
  const text = `${subject}\n${stripQuotedText(typeof body === "string" ? body : "")}`;
  if (NO_DATA_PATTERNS.some((r) => r.test(text))) return "no_data";
  if (DENIED_PATTERNS.some((r) => r.test(text))) return "denied";
  if (CONFIRMED_PATTERNS.some((r) => r.test(text))) return "confirmed";
  return "unknown";
}

// 20260715 RG - Il campo From: è banale da falsificare e la casella da cui scrivi è nota
// a ogni broker: senza questo controllo chiunque può spedirti un "your data has been
// removed" spacciandosi per privacy@broker.com e farti chiudere la pratica.
// Authentication-Results lo scrive il TUO server dopo aver validato SPF/DKIM/DMARC: è
// l'unico giudizio non controllato dal mittente. Se manca, non si chiude nulla.
export function isSenderAuthenticated(headerValue: unknown): boolean {
  const raw = Array.isArray(headerValue) ? headerValue.join(" ") : String(headerValue ?? "");
  if (!raw) return false;
  if (/dmarc=pass/i.test(raw)) return true;
  return /dkim=pass/i.test(raw) || /spf=pass/i.test(raw);
}

// 20260701 RG - L'abbinamento avviene solo per uguaglianza esatta tra il mittente
// e broker.contactTarget: se il broker risponde da un indirizzo diverso (noreply,
// ticketing) la risposta non viene associata a nessuna pratica.
async function matchCase(fromAddress: string) {
  const cases = await prisma.removalCase.findMany({
    where: {
      status: { in: [CaseStatus.SENT, CaseStatus.ACCESS_SENT, CaseStatus.AWAITING_RESPONSE] },
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

  let verdict = classify(subject, body);

  // 20260715 RG - Solo un mittente autenticato può CHIUDERE una pratica. Se SPF/DKIM
  // non risultano passati, il verdetto viene declassato: la mail resta agli atti come
  // prova, ma la pratica va in revisione manuale invece di risultare risolta.
  const authenticated = isSenderAuthenticated(parsed.headers.get("authentication-results"));
  if (!authenticated && (verdict === "confirmed" || verdict === "no_data")) {
    log("imap", `from=${from} NON autenticato (SPF/DKIM non passati o header assente): "${verdict}" declassato a revisione manuale`);
    verdict = "unknown";
  }

  log("imap", `from=${from} | subject="${subject.slice(0, 60)}" → ${verdict} | auth=${authenticated} | ${matchedCases.length} case(s)`);

  for (const c of matchedCases) {
    const stored = writeEvidenceFile(
      `imap-${c.id}-${Date.now()}.txt`,
      `From: ${from}\nSubject: ${subject}\nDate: ${new Date().toISOString()}\n\n${body}`
    );
    await prisma.evidence.create({
      data: {
        id: await nextId("evidence"),
        caseId: c.id,
        type: EvidenceType.broker_response,
        filePath: stored.filePath,
        checksum: stored.checksum,
        encrypted: false,
      },
    });

    if (verdict === "no_data") {
      await prisma.removalCase.update({
        where: { id: c.id },
        data: { status: CaseStatus.NO_DATA, closedAt: new Date() },
      });
      log("imap", `case ${c.id} → NO_DATA (il broker dichiara di non avere dati)`);
    } else if (verdict === "confirmed") {
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
