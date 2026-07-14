import { prisma } from "./prisma";

// 20260701 RG - Identificativi brevi e leggibili (P001, A001, B0001...) al posto dei
// cuid. Il contatore di ogni entità vive nella tabella Setting: senza persisterlo,
// dopo un riavvio la numerazione ripartirebbe da 1 e si scontrerebbe con le righe
// già esistenti. Il padding è solo estetico: superata la soglia l'id si allunga
// (B9999 -> B10000) e resta comunque univoco.
const CONFIG = {
  person:   { prefix: "P", pad: 3 },
  address:  { prefix: "A", pad: 3 },
  broker:   { prefix: "B", pad: 4 },
  case:     { prefix: "C", pad: 6 },
  message:  { prefix: "M", pad: 6 },
  evidence: { prefix: "E", pad: 5 },
  task:     { prefix: "T", pad: 6 },
} as const;

export type IdEntity = keyof typeof CONFIG;

export const SEQ_KEYS = Object.keys(CONFIG).map((e) => `seq_${e}`);

// Riserva in transazione un blocco di `count` numeri: due richieste in parallelo
// non possono così ottenere lo stesso id.
export async function nextIds(entity: IdEntity, count: number): Promise<string[]> {
  if (count <= 0) return [];
  const { prefix, pad } = CONFIG[entity];
  const key = `seq_${entity}`;

  const start = await prisma.$transaction(async (tx) => {
    const row = await tx.setting.findUnique({ where: { key } });
    const current = row ? Number.parseInt(row.value, 10) || 0 : 0;
    await tx.setting.upsert({
      where: { key },
      update: { value: String(current + count) },
      create: { key, value: String(current + count) },
    });
    return current;
  });

  return Array.from({ length: count }, (_, i) =>
    prefix + String(start + i + 1).padStart(pad, "0")
  );
}

export async function nextId(entity: IdEntity): Promise<string> {
  return (await nextIds(entity, 1))[0];
}

// Usato dal reset: azzera i contatori così la numerazione riparte da 1.
export async function resetSequences(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: { in: SEQ_KEYS } } });
}
