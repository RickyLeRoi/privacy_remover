import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { z } from "zod";
import { nextId } from "../lib/ids";
import { prisma } from "../lib/prisma";
import { EVIDENCE_DIR, ensureEvidenceDir, sha256File } from "../lib/evidenceStore";

export const evidenceRouter = Router();

ensureEvidenceDir();

const EvidenceTypeSchema = z
  .enum(["sent_email", "broker_response", "screenshot", "id_doc"])
  .default("screenshot");

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, EVIDENCE_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".pdf", ".png", ".jpg", ".jpeg", ".eml", ".txt"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error("File type not allowed"));
  },
});

evidenceRouter.post(
  "/cases/:caseId",
  upload.single("file"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // 20260701 RG - La colonna type è una String libera (SQLite non ha enum):
    // senza questa validazione il client può scriverci qualunque valore.
    const parsedType = EvidenceTypeSchema.safeParse(req.body.type ?? undefined);
    if (!parsedType.success) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Invalid evidence type" });
    }

    const caseExists = await prisma.removalCase.findUnique({
      where: { id: req.params.caseId },
    });
    if (!caseExists) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: "Case not found" });
    }

    const evidence = await prisma.evidence.create({
      data: {
        id: await nextId("evidence"),
        caseId: req.params.caseId,
        type: parsedType.data,
        filePath: path.relative(EVIDENCE_DIR, req.file.path),
        checksum: sha256File(req.file.path),
        encrypted: false,
      },
    });

    res.status(201).json(evidence);
  }
);

evidenceRouter.get("/cases/:caseId", async (req, res) => {
  const evidence = await prisma.evidence.findMany({
    where: { caseId: req.params.caseId },
    orderBy: { createdAt: "asc" },
  });
  res.json(evidence);
});

evidenceRouter.get("/:id/download", async (req, res) => {
  const ev = await prisma.evidence.findUnique({ where: { id: req.params.id } });
  if (!ev) return res.status(404).json({ error: "Not found" });

  const filePath = path.join(EVIDENCE_DIR, ev.filePath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found on disk" });
  }

  res.download(filePath);
});

evidenceRouter.delete("/:id", async (req, res) => {
  const ev = await prisma.evidence.findUnique({ where: { id: req.params.id } });
  if (!ev) return res.status(404).json({ error: "Not found" });

  const filePath = path.join(EVIDENCE_DIR, ev.filePath);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  await prisma.evidence.delete({ where: { id: req.params.id } });
  res.status(204).end();
});
