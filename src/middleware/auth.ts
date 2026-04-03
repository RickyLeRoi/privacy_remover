import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { log } from "../index";

// Simple Bearer token auth — use only over VPN/LAN.
// Token = bcrypt hash comparison against ADMIN_PASSWORD_HASH env.
// Generate hash: node -e "console.log(require('bcryptjs').hashSync('yourpassword', 12))"
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

  // Bearer header (API calls)
  let token = req.headers.authorization?.replace("Bearer ", "").trim();

  // Query-param fallback — used only by file download endpoints (/api/export/*)
  // Acceptable on private LAN; never expose these endpoints publicly.
  if (!token && req.path.startsWith("/export/")) {
    token = typeof req.query.token === "string" ? req.query.token : undefined;
  }

  if (!token || !(await bcrypt.compare(token, hash))) {
    log("auth", `401 ${req.method} ${req.path} — bad or missing token`);
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
