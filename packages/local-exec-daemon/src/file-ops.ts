import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { ReadFileInput, ReadFileOutput, WriteFileInput, WriteFileOutput, ListDirectoryInput, ListDirectoryOutput, DirectoryEntry } from "./types.js";

export async function readFileOperation(input: ReadFileInput): Promise<ReadFileOutput> {
  const resolvedPath = path.resolve(input.path);
  const rawBytes = await fs.readFile(resolvedPath);
  const sha256 = crypto.createHash("sha256").update(rawBytes).digest("hex");
  const fullText = rawBytes.toString("utf-8");
  const lines = fullText.split("\n");
  const totalLines = lines.length;

  let selectedContent = fullText;

  if (input.start_line !== undefined || input.end_line !== undefined) {
    const start = Math.max(1, input.start_line ?? 1);
    const end = Math.min(totalLines, input.end_line ?? totalLines);
    if (start <= end) {
      selectedContent = lines.slice(start - 1, end).join("\n");
    } else {
      selectedContent = "";
    }
  }

  return {
    path: resolvedPath,
    totalLines,
    content: selectedContent,
    sha256,
    bytes: rawBytes.byteLength,
  };
}

export async function writeFileOperation(input: WriteFileInput): Promise<WriteFileOutput> {
  const resolvedPath = path.resolve(input.path);
  const parentDir = path.dirname(resolvedPath);
  await fs.mkdir(parentDir, { recursive: true });

  let exists = false;
  try {
    await fs.stat(resolvedPath);
    exists = true;
  } catch {
    exists = false;
  }

  if (exists && input.overwrite === false) {
    throw new Error(`File already exists and overwrite is set to false: ${resolvedPath}`);
  }

  // Atomic write via temp file
  const tempPath = path.join(parentDir, `.${path.basename(resolvedPath)}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const buffer = Buffer.from(input.content, "utf-8");
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  try {
    await fs.writeFile(tempPath, buffer, { mode: 0o600 });
    await fs.rename(tempPath, resolvedPath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }

  return {
    path: resolvedPath,
    bytesWritten: buffer.byteLength,
    sha256,
    created: !exists,
  };
}

export async function listDirectoryOperation(input: ListDirectoryInput): Promise<ListDirectoryOutput> {
  const resolvedPath = path.resolve(input.path);
  const entries: DirectoryEntry[] = [];

  async function scan(currentDir: string, currentDepth: number, maxDepth: number) {
    const dirEntries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const ent of dirEntries) {
      const fullPath = path.join(currentDir, ent.name);
      let type: DirectoryEntry["type"] = "other";
      let size = 0;
      let modifiedAtMs = 0;

      try {
        const stat = await fs.lstat(fullPath);
        if (stat.isFile()) type = "file";
        else if (stat.isDirectory()) type = "directory";
        else if (stat.isSymbolicLink()) type = "symlink";

        size = stat.size;
        modifiedAtMs = stat.mtimeMs;
      } catch {
        // Skip unreadable files
      }

      entries.push({
        name: path.relative(resolvedPath, fullPath),
        type,
        size,
        modifiedAtMs,
      });

      if (input.recursive && type === "directory" && currentDepth < maxDepth) {
        await scan(fullPath, currentDepth + 1, maxDepth);
      }
    }
  }

  await scan(resolvedPath, 1, input.max_depth ?? 5);

  return {
    path: resolvedPath,
    entries,
  };
}
