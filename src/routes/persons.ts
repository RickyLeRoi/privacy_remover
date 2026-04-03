import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";

export const personsRouter = Router();

const AddressSchema = z.object({
  street:  z.string(),
  city:    z.string(),
  region:  z.string().optional(),
  country: z.string().default("IT"),
  current: z.boolean().default(false),
});

const PersonSchema = z.object({
  label:   z.string(),                      // internal tag, never sent to brokers
  emails:  z.array(z.string().email()),
  phones:  z.array(z.string()),
  addresses: z.array(AddressSchema).default([]),
  aliases: z.array(z.string()).default([]),
  // fullName is response-only: present in schema but never used for discovery
  fullName: z.string().optional(),
  notes:   z.string().optional(),
});

personsRouter.get("/", async (_req, res) => {
  const persons = await prisma.person.findMany({
    include: { addresses: true, cases: { select: { id: true, status: true } } },
  });
  // Omit fullName from list responses — exposed only when explicitly needed
  const safe = persons.map(({ fullName: _fn, ...p }) => p);
  res.json(safe);
});

personsRouter.post("/", async (req, res) => {
  const parsed = PersonSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);
  const { addresses, ...data } = parsed.data;
  const person = await prisma.person.create({
    data: { ...data, addresses: { create: addresses } },
    include: { addresses: true },
  });
  const { fullName: _fn, ...safe } = person;
  res.status(201).json(safe);
});

personsRouter.get("/:id", async (req, res) => {
  const p = await prisma.person.findUnique({
    where: { id: req.params.id },
    include: { addresses: true },
  });
  if (!p) return res.status(404).json({ error: "Not found" });
  const { fullName: _fn, ...safe } = p;
  res.json(safe);
});

// Separate endpoint to retrieve fullName — explicit, auditable
personsRouter.get("/:id/response-identity", async (req, res) => {
  const p = await prisma.person.findUnique({ where: { id: req.params.id } });
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json({ fullName: p.fullName ?? null });
});
