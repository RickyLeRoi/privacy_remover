import cron from "node-cron";
import { addDays } from "date-fns";
import { CaseStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { pollInbox } from "./imapService";
import { log, logErr } from "../index";

// Track last successful IMAP poll time for status endpoint
export let lastImapPoll: Date | null = null;
export let lastImapError: string | null = null;

export async function initScheduler() {
  log("scheduler", "initializing jobs...");

  // ── Job: flag overdue cases — runs every 6 hours ─────────────
  cron.schedule("0 */6 * * *", async () => {
    log("scheduler", "running flag-overdue job");
    try {
      const result = await prisma.removalCase.updateMany({
        where: {
          status: CaseStatus.SENT,
          dueAt: { lt: new Date() },
        },
        data: { status: CaseStatus.NEEDS_RECHECK },
      });
      log("scheduler", `flag-overdue: ${result.count} cases updated`);
    } catch (err) {
      logErr("scheduler", "flag-overdue failed", err);
    }
  });

  // ── Job: schedule re-verification tasks — runs every 12 hours ─
  cron.schedule("0 */12 * * *", async () => {
    log("scheduler", "running reverification job");
    try {
      const confirmed = await prisma.removalCase.findMany({
        where: {
          status: CaseStatus.CONFIRMED,
          nextCheckAt: { lte: new Date() },
        },
      });
      for (const c of confirmed) {
        await prisma.verificationTask.create({
          data: { caseId: c.id, scheduledFor: new Date() },
        });
        await prisma.removalCase.update({
          where: { id: c.id },
          data: { nextCheckAt: addDays(new Date(), 90) },
        });
      }
      log("scheduler", `reverification: created ${confirmed.length} task(s)`);
    } catch (err) {
      logErr("scheduler", "reverification failed", err);
    }
  });

  // ── Job: IMAP inbox polling — every 30 minutes ────────────────
  if (process.env.IMAP_ENABLED !== "false") {
    log("scheduler", `IMAP polling enabled — host=${process.env.IMAP_HOST ?? "not set"}  user=${process.env.IMAP_USER ?? "not set"}`);
    pollInbox()
      .then(() => { lastImapPoll = new Date(); log("scheduler", "initial IMAP poll complete"); })
      .catch((e) => { lastImapError = String(e); logErr("scheduler", "initial IMAP poll failed", e); });

    cron.schedule("*/30 * * * *", async () => {
      log("scheduler", "running IMAP poll job");
      try {
        await pollInbox();
        lastImapPoll = new Date();
        lastImapError = null;
        log("scheduler", "IMAP poll complete");
      } catch (err) {
        lastImapError = String(err);
        logErr("scheduler", "IMAP poll failed", err);
      }
    });
  } else {
    log("scheduler", "IMAP polling disabled (IMAP_ENABLED=false)");
  }

  log("scheduler", "all jobs registered");
}
