import { Router } from "express";
import { z } from "zod";
import { nextId } from "../lib/ids";
import { prisma } from "../lib/prisma";
import { packList, brokerOut } from "../lib/serialize";

export const brokersRouter = Router();

brokersRouter.get("/", async (_req, res) => {
  const brokers = await prisma.broker.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
  });
  res.json(brokers.map(brokerOut));
});

brokersRouter.get("/:id", async (req, res) => {
  const b = await prisma.broker.findUnique({ where: { id: req.params.id } });
  if (!b) return res.status(404).json({ error: "Not found" });
  res.json(brokerOut(b));
});

const BrokerSchema = z.object({
  name:                   z.string().min(1),
  country:                z.string().length(2),
  legalBasis:             z.enum(["gdpr", "ccpa", "opt_out"]),
  contactMethod:          z.enum(["email", "form", "api"]),
  contactTarget:          z.string().min(1),
  portalUrl:              z.string().url().optional(),
  slaInDays:              z.number().int().positive().default(30),
  requiresFullName:       z.boolean().default(false),
  requiresIdProof:        z.boolean().default(false),
  acceptedDiscoveryKeys:  z.array(z.enum(["email", "phone", "address"])).min(1),
  active:                 z.boolean().default(true),
  notes:                  z.string().optional(),
});

brokersRouter.post("/", async (req, res) => {
  const parsed = BrokerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);
  const { acceptedDiscoveryKeys, ...rest } = parsed.data;
  const b = await prisma.broker.create({
    data: { id: await nextId("broker"), ...rest, acceptedDiscoveryKeys: packList(acceptedDiscoveryKeys) },
  });
  res.status(201).json(brokerOut(b));
});

brokersRouter.patch("/:id", async (req, res) => {
  const existing = await prisma.broker.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });

  const parsed = BrokerSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const { acceptedDiscoveryKeys, ...rest } = parsed.data;
  const b = await prisma.broker.update({
    where: { id: req.params.id },
    data: {
      ...rest,
      ...(acceptedDiscoveryKeys !== undefined
        ? { acceptedDiscoveryKeys: packList(acceptedDiscoveryKeys) }
        : {}),
    },
  });
  res.json(brokerOut(b));
});

brokersRouter.delete("/:id", async (req, res) => {
  const existing = await prisma.broker.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  await prisma.broker.update({ where: { id: req.params.id }, data: { active: false } });
  res.status(204).end();
});
