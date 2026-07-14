import { nextIds } from "./lib/ids";
import { prisma } from "./lib/prisma";
import { packList } from "./lib/serialize";
import { getSetting, setSetting } from "./lib/settings";
import brokerCatalog from "./data/brokers.json";

// 20260701 RG - Alzare questa versione quando cambia src/data/brokers.json: le
// installazioni esistenti hanno già dei broker a DB, quindi senza un confronto di
// versione il seed verrebbe saltato e non riceverebbero mai i nuovi.
export const BROKERS_VERSION = "2026-07-14";
const VERSION_KEY = "brokers_seed_version";

type SeedBroker = {
  name: string;
  country: string;
  legalBasis: string;
  contactMethod: string;
  contactTarget: string;
  portalUrl?: string;
  slaInDays: number;
  requiresFullName: boolean;
  requiresIdProof: boolean;
  acceptedDiscoveryKeys: string[];
  notes?: string;
};

export const brokers = brokerCatalog as SeedBroker[];

export async function seedBrokers(): Promise<number> {
  const existing = new Set(
    (await prisma.broker.findMany({ select: { name: true } })).map((b) => b.name)
  );

  const missing = brokers.filter((b) => !existing.has(b.name));
  const ids = await nextIds("broker", missing.length);

  // 20260701 RG - createMany in blocchi: con ~1900 righe, un upsert per broker
  // significherebbe altrettante query e un primo avvio di parecchi secondi.
  const CHUNK = 200;
  for (let i = 0; i < missing.length; i += CHUNK) {
    await prisma.broker.createMany({
      data: missing.slice(i, i + CHUNK).map((b, j) => ({
        id: ids[i + j],
        name: b.name,
        country: b.country,
        legalBasis: b.legalBasis,
        contactMethod: b.contactMethod,
        contactTarget: b.contactTarget,
        portalUrl: b.portalUrl ?? null,
        slaInDays: b.slaInDays,
        requiresFullName: b.requiresFullName,
        requiresIdProof: b.requiresIdProof,
        acceptedDiscoveryKeys: packList(b.acceptedDiscoveryKeys),
        notes: b.notes ?? null,
      })),
    });
  }

  await setSetting(VERSION_KEY, BROKERS_VERSION);
  return missing.length;
}

async function main() {
  const current = await getSetting(VERSION_KEY);
  if (current === BROKERS_VERSION) {
    const n = await prisma.broker.count();
    console.log(`Broker catalog already at ${BROKERS_VERSION} (${n} brokers) — skipping.`);
    return;
  }

  console.log(`Seeding broker catalog ${BROKERS_VERSION}...`);
  const added = await seedBrokers();
  const total = await prisma.broker.count();
  console.log(`Added ${added} new brokers (${total} total).`);
}

if (require.main === module) {
  main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
}
