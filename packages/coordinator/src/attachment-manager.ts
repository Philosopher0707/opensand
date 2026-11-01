import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { AttachmentRecord } from "./types.js";

export class AttachmentManager {
  private baseDir: string;

  constructor(customDir?: string) {
    this.baseDir = customDir ?? path.join(os.homedir(), ".opensand", "attachments");
  }

  get storageDirectory(): string {
    return this.baseDir;
  }

  async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
  }

  private detectMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
      case ".png": return "image/png";
      case ".jpg":
      case ".jpeg": return "image/jpeg";
      case ".webp": return "image/webp";
      case ".gif": return "image/gif";
      case ".pdf": return "application/pdf";
      case ".txt": return "text/plain";
      case ".md": return "text/markdown";
      case ".json": return "application/json";
      case ".ts":
      case ".js":
      case ".mjs": return "text/javascript";
      case ".html": return "text/html";
      case ".diff":
      case ".patch": return "text/x-diff";
      default: return "application/octet-stream";
    }
  }

  async stageFile(sourcePath: string): Promise<AttachmentRecord> {
    await this.ensureDirectory();
    const resolvedSource = path.resolve(sourcePath);
    const buffer = await fs.readFile(resolvedSource);
    const filename = path.basename(resolvedSource);
    return this.stageBytes(filename, buffer);
  }

  async stageBytes(filename: string, content: Buffer | Uint8Array): Promise<AttachmentRecord> {
    await this.ensureDirectory();
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const rand = crypto.randomBytes(3).toString("hex");
    const id = `att_${sha256.slice(0, 12)}_${rand}`;
    const targetDir = path.join(this.baseDir, id);
    await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });

    const safeFilename = path.basename(filename) || "attachment.bin";
    const destPath = path.join(targetDir, safeFilename);
    await fs.writeFile(destPath, content, { mode: 0o600 });

    const meta: AttachmentRecord = {
      id,
      filename: safeFilename,
      localPath: destPath,
      sizeBytes: content.length,
      mimeType: this.detectMimeType(safeFilename),
      sha256,
      stagedAtMs: Date.now(),
    };

    const metaPath = path.join(targetDir, "meta.json");
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });

    return meta;
  }

  async listAttachments(): Promise<AttachmentRecord[]> {
    await this.ensureDirectory();
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      const records: AttachmentRecord[] = [];

      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        try {
          const metaPath = path.join(this.baseDir, ent.name, "meta.json");
          const raw = await fs.readFile(metaPath, "utf-8");
          const parsed = JSON.parse(raw) as AttachmentRecord;
          if (parsed && parsed.id && parsed.localPath) {
            records.push(parsed);
          }
        } catch {
          // Ignore incomplete or corrupted dirs
        }
      }

      return records.sort((a, b) => b.stagedAtMs - a.stagedAtMs);
    } catch {
      return [];
    }
  }

  async getAttachment(id: string): Promise<AttachmentRecord | null> {
    const targetDir = path.join(this.baseDir, id);
    const metaPath = path.join(targetDir, "meta.json");
    try {
      const raw = await fs.readFile(metaPath, "utf-8");
      return JSON.parse(raw) as AttachmentRecord;
    } catch {
      return null;
    }
  }

  async deleteAttachment(id: string): Promise<boolean> {
    const targetDir = path.join(this.baseDir, id);
    try {
      await fs.rm(targetDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}
