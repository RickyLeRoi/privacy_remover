import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { ADMIN_PASSWORD_HASH_KEY, getSetting, setSetting } from "../lib/settings";
import { log } from "../index";

const MIN_PASSWORD_LENGTH = 8;

// 20260701 RG - Precedenza: ADMIN_PASSWORD_HASH (env) batte il valore nel DB.
// Serve come via di recupero: se dimentichi la password, avvii il container con
// l'env valorizzata e torni dentro.
async function currentHash(): Promise<string | null> {
  const fromEnv = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (fromEnv) return fromEnv;
  return getSetting(ADMIN_PASSWORD_HASH_KEY);
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  let token = req.headers.authorization?.replace("Bearer ", "").trim();

  // 20260701 RG - Il token in query string finisce nei log e nella cronologia:
  // accettabile solo perché il servizio gira in LAN/VPN. Non esporre /export/*
  // pubblicamente.
  if (!token && req.path.startsWith("/export/")) {
    token = typeof req.query.token === "string" ? req.query.token : undefined;
  }

  if (!token) {
    log("auth", `401 ${req.method} ${req.path} — missing token`);
    return res.status(401).json({ error: "Unauthorized" });
  }

  const hash = await currentHash();

  if (!hash) {
    // 20260701 RG - Nessuna password ancora impostata. La finestra di "primo login"
    // è chiusa a meno che l'operatore non l'abbia aperta esplicitamente: senza questo
    // gate, chiunque raggiunga l'app appena avviata potrebbe rivendicarla.
    if (process.env.ALLOW_SETUP !== "true") {
      log("auth", `401 ${req.method} ${req.path} — nessuna password impostata e ALLOW_SETUP non abilitato`);
      return res.status(401).json({
        error: "Setup non abilitato. Riavvia il container con ALLOW_SETUP=true per impostare la password al primo login.",
      });
    }

    if (token.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `La password deve essere di almeno ${MIN_PASSWORD_LENGTH} caratteri.`,
      });
    }

    await setSetting(ADMIN_PASSWORD_HASH_KEY, bcrypt.hashSync(token, 12));
    log("auth", "SETUP: password impostata al primo login e salvata nel DB. Riavvia senza ALLOW_SETUP=true per chiudere il setup.");
    return next();
  }

  if (!(await bcrypt.compare(token, hash))) {
    log("auth", `401 ${req.method} ${req.path} — bad token`);
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}
