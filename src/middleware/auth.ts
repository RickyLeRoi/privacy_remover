import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { log } from "../index";

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const hash = process.env.ADMIN_PASSWORD_HASH;

  if (!hash) {
    log("auth", "ADMIN_PASSWORD_HASH not set — rejecting all requests");
    return res.status(401).json({ error: "Unauthorized" });
  }

  let token = req.headers.authorization?.replace("Bearer ", "").trim();

  // 20260701 RG - Il token in query string finisce nei log e nella cronologia:
  // accettabile solo perché il servizio gira in LAN/VPN. Non esporre /export/*
  // pubblicamente.
  if (!token && req.path.startsWith("/export/")) {
    token = typeof req.query.token === "string" ? req.query.token : undefined;
  }

  if (!token || !(await bcrypt.compare(token, hash))) {
    log("auth", `401 ${req.method} ${req.path} — bad or missing token`);
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
