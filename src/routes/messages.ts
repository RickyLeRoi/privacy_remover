import { Router } from "express";
import { prisma } from "../lib/prisma";

export const messagesRouter = Router();

messagesRouter.get("/case/:caseId", async (req, res) => {
  const msgs = await prisma.outboundMessage.findMany({
    where: { caseId: req.params.caseId },
    orderBy: { createdAt: "asc" },
  });
  res.json(msgs);
});
