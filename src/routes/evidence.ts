import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { prisma } from "../lib/prisma";

export const evidenceRouter = Router();

const EVIDENCE_DIR = path.join(process.cwd(), "evidence");

// Ensure the evidence directory exists
if (!fs.existsSync(EVIDENCE_DIR)) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, EVIDENCE_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter: (_req, file, cb) => {
    const allowed = [".pdf", ".png", ".jpg", ".jpeg", ".eml", ".txt"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error("File type not allowed"));
  },
});

function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Upload evidence for a case
evidenceRouter.post(
  "/cases/:caseId",
  upload.single("file"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const caseExists = await prisma.removalCase.findUnique({
      where: { id: req.params.caseId },
    });
    if (!caseExists) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: "Case not found" });
    }

    const checksum = sha256File(req.file.path);
    const relPath = path.relative(EVIDENCE_DIR, req.file.path);

    const evidence = await prisma.evidence.create({
      data: {
        caseId: req.params.caseId,
        type: (req.body.type as any) ?? "screenshot",
        filePath: relPath,
        checksum,
        encrypted: false,
      },
    });

    res.status(201).json(evidence);
  }
);

// List evidence for a case
evidenceRouter.get("/cases/:caseId", async (req, res) => {
  const evidence = await prisma.evidence.findMany({
    where: { caseId: req.params.caseId },
    orderBy: { createdAt: "asc" },
  });
  res.json(evidence);
});

// Download an evidence file
evidenceRouter.get("/:id/download", async (req, res) => {
  const ev = await prisma.evidence.findUnique({ where: { id: req.params.id } });
  if (!ev) return res.status(404).json({ error: "Not found" });

  const filePath = path.join(EVIDENCE_DIR, ev.filePath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found on disk" });
  }

  res.download(filePath);
});

// Delete an evidence file
evidenceRouter.delete("/:id", async (req, res) => {
  const ev = await prisma.evidence.findUnique({ where: { id: req.params.id } });
  if (!ev) return res.status(404).json({ error: "Not found" });

  const filePath = path.join(EVIDENCE_DIR, ev.filePath);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  await prisma.evidence.delete({ where: { id: req.params.id } });
  res.status(204).end();
});
