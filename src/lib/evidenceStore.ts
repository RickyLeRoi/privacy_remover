import path from "path";
import fs from "fs";
import crypto from "crypto";

export const EVIDENCE_DIR = path.join(process.cwd(), "evidence");

export function ensureEvidenceDir(): void {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
}

export function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function writeEvidenceFile(
  fileName: string,
  content: string
): { filePath: string; checksum: string } {
  ensureEvidenceDir();
  const abs = path.join(EVIDENCE_DIR, fileName);
  fs.writeFileSync(abs, content, "utf8");
  return {
    filePath: path.relative(EVIDENCE_DIR, abs),
    checksum: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
  };
}
