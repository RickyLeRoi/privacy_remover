import { Router } from "express";
import { z } from "zod";
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

const PersonSchema = z.object({
  label:   z.string(),
  emails:  z.array(z.string().email()),
  phones:  z.array(z.string()),
  addresses: z.array(AddressSchema).default([]),
  aliases: z.array(z.string()).default([]),
  fullName: z.string().optional(),
  notes:   z.string().optional(),
});

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
  const { addresses, emails, phones, aliases, ...rest } = parsed.data;
  const person = await prisma.person.create({
    data: {
      ...rest,
      emails:  packList(emails),
      phones:  packList(phones),
      aliases: packList(aliases),
      addresses: { create: addresses },
    },
    include: { addresses: true },
  });
  const { fullName: _fn, ...safe } = person;
  res.status(201).json(personOut(safe));
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

personsRouter.get("/:id/response-identity", async (req, res) => {
  const p = await prisma.person.findUnique({ where: { id: req.params.id } });
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json({ fullName: p.fullName ?? null });
});
