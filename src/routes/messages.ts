import { prisma } from "../lib/prisma";
import { asyncRouter } from "../lib/asyncRouter";

export const messagesRouter = asyncRouter();

messagesRouter.get("/case/:caseId", async (req, res) => {
  const msgs = await prisma.outboundMessage.findMany({
    where: { caseId: req.params.caseId },
    orderBy: { createdAt: "asc" },
  });
  res.json(msgs);
});
