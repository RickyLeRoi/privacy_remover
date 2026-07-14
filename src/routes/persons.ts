import { Router } from "express";
import { z } from "zod";
import { nextId, nextIds } from "../lib/ids";
import { prisma } from "../lib/prisma";
import { packList, personOut } from "../lib/serialize";

export const personsRouter = Router();

const AddressSchema = z.object({
  street:  z.string(),
  city:    z.string(),
  region:  z.string().optional(),
  country: z.string().default("IT"),
  current: z.boolean().default(false),
});

// 20260714 RG - Una Person = una email (vedi prisma/schema.prisma). Per una seconda
// email si crea una seconda Person, con un'etichetta che le distingua.
const PersonSchema = z.object({
  label:   z.string(),
  email:   z.string().email(),
  phones:  z.array(z.string()),
  addresses: z.array(AddressSchema).default([]),
  aliases: z.array(z.string()).default([]),
  fullName: z.string().optional(),
  notes:   z.string().optional(),
});

// 20260714 RG - email è @unique: senza questo, il vincolo violato uscirebbe come 500
// con lo stack di Prisma, mentre è un banale errore di compilazione dell'utente.
function isDuplicateEmail(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

const DUPLICATE_EMAIL = {
  error: "Esiste già una persona con questa email. Ogni email appartiene a una sola persona.",
};

// 20260701 RG - fullName va escluso da ogni risposta di lista/dettaglio: è
// esposto solo da /:id/response-identity, in modo esplicito e tracciabile.
personsRouter.get("/", async (_req, res) => {
  const persons = await prisma.person.findMany({
    include: { addresses: true, cases: { select: { id: true, status: true } } },
  });
  const safe = persons.map(({ fullName: _fn, ...p }) => personOut(p));
  res.json(safe);
});

personsRouter.post("/", async (req, res) => {
  const parsed = PersonSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);
  const { addresses, phones, aliases, ...rest } = parsed.data;
  const addressIds = await nextIds("address", addresses.length);

  try {
    const person = await prisma.person.create({
      data: {
        id: await nextId("person"),
        ...rest,
        phones:  packList(phones),
        aliases: packList(aliases),
        addresses: { create: addresses.map((a, i) => ({ id: addressIds[i], ...a })) },
      },
      include: { addresses: true },
    });
    const { fullName: _fn, ...safe } = person;
    res.status(201).json(personOut(safe));
  } catch (e) {
    if (isDuplicateEmail(e)) return res.status(409).json(DUPLICATE_EMAIL);
    throw e;
  }
});

personsRouter.get("/:id", async (req, res) => {
  const p = await prisma.person.findUnique({
    where: { id: req.params.id },
    include: { addresses: true },
  });
  if (!p) return res.status(404).json({ error: "Not found" });
  const { fullName: _fn, ...safe } = p;
  res.json(personOut(safe));
});

// 20260701 RG - Update parziale: i campi assenti non vengono toccati. Serve perché
// fullName non è mai esposto in lettura, quindi la UI non può rimandarlo indietro
// e un update "pieno" lo cancellerebbe a ogni salvataggio.
const PersonUpdateSchema = PersonSchema.partial();

personsRouter.put("/:id", async (req, res) => {
  const parsed = PersonUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const existing = await prisma.person.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });

  const { addresses, phones, aliases, ...rest } = parsed.data;

  // Gli Address non hanno un id stabile lato client: quando arrivano, si
  // sostituisce l'intero set invece di fare il diff riga per riga.
  const addressIds = addresses ? await nextIds("address", addresses.length) : [];

  let person;
  try {
    person = await prisma.person.update({
      where: { id: req.params.id },
      data: {
        ...rest,
        ...(phones  && { phones:  packList(phones) }),
        ...(aliases && { aliases: packList(aliases) }),
        ...(addresses && {
          addresses: {
            deleteMany: {},
            create: addresses.map((a, i) => ({ id: addressIds[i], ...a })),
          },
        }),
      },
      include: { addresses: true },
    });
  } catch (e) {
    if (isDuplicateEmail(e)) return res.status(409).json(DUPLICATE_EMAIL);
    throw e;
  }

  const { fullName: _fn, ...safe } = person;
  res.json(personOut(safe));
});

personsRouter.get("/:id/response-identity", async (req, res) => {
  const p = await prisma.person.findUnique({ where: { id: req.params.id } });
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json({ fullName: p.fullName ?? null });
});
