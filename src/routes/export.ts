import { Router } from "express";
import PDFDocument from "pdfkit";
import { prisma } from "../lib/prisma";
import { unpackList } from "../lib/serialize";

export const exportRouter = Router();

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function escapeCsv(v: unknown): string {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const STATUS_IT: Record<string, string> = {
  NOT_STARTED: "Non avviato",
  SENT: "Inviata",
  AWAITING_RESPONSE: "Risposta attesa",
  CONFIRMED: "Rimossa",
  FAILED: "Fallita",
  NEEDS_RECHECK: "Verifica",
  CLOSED: "Chiusa",
};

async function fetchCases(personId?: string) {
  return prisma.removalCase.findMany({
    where: personId ? { personId } : undefined,
    include: {
      person: { select: { id: true, label: true, emails: true } },
      broker: { select: { name: true, country: true, legalBasis: true, contactMethod: true } },
      messages: { select: { sentAt: true }, orderBy: { createdAt: "asc" }, take: 1 },
      evidence: { select: { id: true } },
    },
    orderBy: [{ person: { label: "asc" } }, { openedAt: "asc" }],
  });
}

exportRouter.get("/csv", async (req, res) => {
  const personId = typeof req.query.personId === "string" ? req.query.personId : undefined;
  const cases = await fetchCases(personId);

  const header = [
    "Persona",
    "Email",
    "Broker",
    "Paese",
    "Base legale",
    "Metodo",
    "Stato",
    "Aperto il",
    "Scadenza",
    "Chiuso il",
    "Prove",
    "Note",
  ].join(",");

  const rows = cases.map((c) =>
    [
      c.person.label,
      unpackList(c.person.emails).join("; "),
      c.broker.name,
      c.broker.country,
      c.broker.legalBasis,
      c.broker.contactMethod,
      STATUS_IT[c.status] ?? c.status,
      fmtDate(c.openedAt),
      fmtDate(c.dueAt),
      fmtDate(c.closedAt),
      c.evidence.length,
      c.notes ?? "",
    ]
      .map(escapeCsv)
      .join(",")
  );

  const csv = [header, ...rows].join("\r\n");
  const filename = `privacy-remover-export-${new Date().toISOString().slice(0, 10)}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // 20260701 RG - Il BOM iniziale serve a Excel/Numbers per riconoscere l'UTF-8:
  // senza, gli accenti risultano corrotti.
  res.send("\uFEFF" + csv);
});

exportRouter.get("/pdf", async (req, res) => {
  const personId = typeof req.query.personId === "string" ? req.query.personId : undefined;
  const cases = await fetchCases(personId);

  const byPerson = new Map<string, typeof cases>();
  for (const c of cases) {
    const arr = byPerson.get(c.person.label) ?? [];
    arr.push(c);
    byPerson.set(c.person.label, arr);
  }

  const doc = new PDFDocument({ margin: 48, size: "A4" });
  const filename = `privacy-remover-report-${new Date().toISOString().slice(0, 10)}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);

  doc
    .fontSize(20)
    .font("Helvetica-Bold")
    .text("Privacy Removal — Report", { align: "center" });
  doc.moveDown(0.4);
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#666666")
    .text(`Generato il ${fmtDate(new Date())} — uso esclusivo famiglia`, { align: "center" });
  doc.moveDown(1.5);

  const total    = cases.length;
  const confirmed = cases.filter((c) => c.status === "CONFIRMED").length;
  const pending  = cases.filter((c) => c.status === "SENT" || c.status === "AWAITING_RESPONSE").length;
  const overdue  = cases.filter((c) => c.status === "NEEDS_RECHECK").length;

  doc.fontSize(12).font("Helvetica-Bold").fillColor("#000000").text("Riepilogo");
  doc.moveDown(0.3);
  doc.fontSize(10).font("Helvetica");
  [
    [`Casi totali`, total],
    [`Rimossi (confermati)`, confirmed],
    [`In corso`, pending],
    [`Da verificare`, overdue],
    [`% Completamento`, total ? `${Math.round((confirmed / total) * 100)}%` : "—"],
  ].forEach(([label, val]) => {
    doc.text(`${label}: ${val}`);
  });
  doc.moveDown(1.5);

  for (const [personLabel, personCases] of byPerson) {
    doc.addPage();
    doc.fontSize(14).font("Helvetica-Bold").fillColor("#000000").text(personLabel);
    doc.fontSize(9).font("Helvetica").fillColor("#444444")
      .text(unpackList(personCases[0].person.emails).join(", "));
    doc.moveDown(0.8);

    const pDone = personCases.filter((c) => c.status === "CONFIRMED").length;
    doc.fontSize(10).font("Helvetica").fillColor("#000000")
      .text(`${pDone}/${personCases.length} rimozioni confermate (${
        Math.round((pDone / personCases.length) * 100)
      }%)`);
    doc.moveDown(0.8);

    const COL = { broker: 48, country: 220, legal: 255, status: 310, opened: 375, due: 430, closed: 480 };
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#333333");
    doc.text("Broker",      COL.broker,  doc.y, { continued: true, width: 165 });
    doc.text("Paese",       COL.country, doc.y, { continued: true, width: 30  });
    doc.text("Legale",      COL.legal,   doc.y, { continued: true, width: 50  });
    doc.text("Stato",       COL.status,  doc.y, { continued: true, width: 60  });
    doc.text("Aperto",      COL.opened,  doc.y, { continued: true, width: 50  });
    doc.text("Scadenza",    COL.due,     doc.y, { continued: true, width: 50  });
    doc.text("Chiuso",      COL.closed,  doc.y, { width: 70 });
    doc.moveDown(0.2);

    const lineY = doc.y;
    doc.moveTo(48, lineY).lineTo(547, lineY).strokeColor("#cccccc").stroke();
    doc.moveDown(0.4);

    doc.font("Helvetica").fillColor("#000000");
    for (const c of personCases) {
      const rowY = doc.y;
      doc.fontSize(8);
      doc.text(c.broker.name,                      COL.broker,  rowY, { continued: true, width: 165 });
      doc.text(c.broker.country,                   COL.country, rowY, { continued: true, width: 30  });
      doc.text(c.broker.legalBasis.toUpperCase(),  COL.legal,   rowY, { continued: true, width: 50  });
      doc.text(STATUS_IT[c.status] ?? c.status,    COL.status,  rowY, { continued: true, width: 60  });
      doc.text(fmtDate(c.openedAt),                COL.opened,  rowY, { continued: true, width: 50  });
      doc.text(fmtDate(c.dueAt),                   COL.due,     rowY, { continued: true, width: 50  });
      doc.text(fmtDate(c.closedAt),                COL.closed,  rowY, { width: 70 });
      doc.moveDown(0.3);

      if (doc.y > 750) doc.addPage();
    }
  }

  doc.end();
});
