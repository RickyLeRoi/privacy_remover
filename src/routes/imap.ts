import { Router } from "express";
import { lastImapPoll, lastImapError } from "../services/schedulerService";
import { pollInbox } from "../services/imapService";

export const imapRouter = Router();

// GET /api/imap/status — current IMAP poller state
imapRouter.get("/status", (_req, res) => {
  const enabled = process.env.IMAP_ENABLED !== "false";
  const configured = !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);

  res.json({
    enabled,
    configured,
    lastPoll: lastImapPoll?.toISOString() ?? null,
    lastError: lastImapError ?? null,
    host: process.env.IMAP_HOST ?? null,
    user: process.env.IMAP_USER ?? null,
  });
});

// POST /api/imap/poll — trigger a manual poll
imapRouter.post("/poll", async (_req, res) => {
  try {
    await pollInbox();
    res.json({ ok: true, polledAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
