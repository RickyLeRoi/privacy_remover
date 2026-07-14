import { Request, Response, NextFunction } from "express";
import { getHash, verifyPassword } from "../lib/adminPassword";
import { log } from "../index";

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

  // 20260701 RG - Nessuna password impostata: l'app è al primo avvio. Non si entra
  // da qui, si passa da POST /api/auth/setup (la dashboard ci arriva da sola
  // interrogando /api/auth/status).
  if (!(await getHash())) {
    return res.status(409).json({ error: "Applicazione non configurata" });
  }

  if (!(await verifyPassword(token))) {
    log("auth", `401 ${req.method} ${req.path} — bad token`);
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}
