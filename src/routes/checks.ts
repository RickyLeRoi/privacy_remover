import { z } from "zod";
import { addDays } from "date-fns";
import { BrokerCategory, CaseStatus, PresenceResult } from "../lib/enums";
import { nextId } from "../lib/ids";
import { prisma } from "../lib/prisma";
import { unpackList } from "../lib/serialize";
import { asyncRouter } from "../lib/asyncRouter";

export const checksRouter = asyncRouter();

// 20260701 RG - Costruisce l'URL di ricerca del broker sostituendo i segnaposto.
// Se il broker non ha un template (la maggior parte), si ripiega sulla sua pagina
// pubblica: la ricerca la fa l'utente a mano. Mai inventare un URL.
function buildSearchUrl(
  template: string | null,
  portalUrl: string | null,
  person: { email: string; phones: string; fullName: string | null; addresses: { city: string }[] }
): string | null {
  if (!template) return portalUrl;

  const email = person.email;
  const phone = (unpackList(person.phones)[0] ?? "").replace(/[^\d+]/g, "");
  const name = person.fullName ?? "";
  const city = person.addresses[0]?.city ?? "";

  // Un segnaposto senza valore renderebbe l'URL inutile: meglio la pagina generica.
  const needed = template.match(/\{(email|phone|name|city)\}/g) ?? [];
  const values: Record<string, string> = { "{email}": email, "{phone}": phone, "{name}": name, "{city}": city };
  if (needed.some((k) => !values[k])) return portalUrl;

  return template.replace(/\{(email|phone|name|city)\}/g, (m) => encodeURIComponent(values[m]));
}

// Elenco dei broker su cui la presenza è verificabile guardando, con l'esito già
// registrato e il link di ricerca pronto.
checksRouter.get("/", async (req, res) => {
  const personId = typeof req.query.personId === "string" ? req.query.personId : undefined;
  if (!personId) return res.status(400).json({ error: "personId richiesto" });

  const person = await prisma.person.findUnique({
    where: { id: personId },
    include: { addresses: true },
  });
  if (!person) return res.status(404).json({ error: "Person not found" });

  const brokers = await prisma.broker.findMany({
    where: { active: true, category: BrokerCategory.people_search },
    orderBy: { name: "asc" },
  });

  const checks = new Map(
    (await prisma.presenceCheck.findMany({ where: { personId } })).map((c) => [c.brokerId, c])
  );
  const cases = new Map(
    (await prisma.removalCase.findMany({ where: { personId }, select: { brokerId: true, id: true, status: true } }))
      .map((c) => [c.brokerId, c])
  );

  res.json(
    brokers.map((b) => ({
      brokerId: b.id,
      name: b.name,
      country: b.country,
      contactMethod: b.contactMethod,
      portalUrl: b.portalUrl,
      searchUrl: buildSearchUrl(b.searchUrlTemplate, b.portalUrl, person),
      hasTemplate: !!b.searchUrlTemplate,
      result: checks.get(b.id)?.result ?? null,
      checkedAt: checks.get(b.id)?.checkedAt ?? null,
      case: cases.get(b.id) ?? null,
    }))
  );
});

const CheckSchema = z.object({
  personId: z.string(),
  brokerId: z.string(),
  result: z.enum(["found", "not_found", "unknown"]),
  notes: z.string().optional(),
});

// Registra l'esito. Se "found", apre subito la pratica: è il senso della verifica,
// aprire solo dove la persona c'è davvero.
checksRouter.post("/", async (req, res) => {
  const parsed = CheckSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);
  const { personId, brokerId, result, notes } = parsed.data;

  const broker = await prisma.broker.findUnique({ where: { id: brokerId } });
  if (!broker) return res.status(404).json({ error: "Broker not found" });

  // Senza questo la create violerebbe la foreign key e uscirebbe un 500 opaco.
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person) return res.status(404).json({ error: "Person not found" });

  const existing = await prisma.presenceCheck.findUnique({
    where: { personId_brokerId: { personId, brokerId } },
  });

  if (existing) {
    await prisma.presenceCheck.update({
      where: { id: existing.id },
      data: { result, notes, checkedAt: new Date() },
    });
  } else {
    await prisma.presenceCheck.create({
      data: { id: await nextId("check"), personId, brokerId, result, notes },
    });
  }

  let openedCase: string | null = null;
  if (result === PresenceResult.found) {
    const already = await prisma.removalCase.findUnique({
      where: { personId_brokerId: { personId, brokerId } },
    });
    if (already) {
      openedCase = already.id;
    } else {
      const c = await prisma.removalCase.create({
        data: {
          id: await nextId("case"),
          personId,
          brokerId,
          status: CaseStatus.NOT_STARTED,
          requestKind: "erasure",
          dueAt: addDays(new Date(), broker.slaInDays),
        },
      });
      openedCase = c.id;
    }
  }

  res.json({ ok: true, result, caseId: openedCase });
});
