import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { WorkspaceEscapeError } from "./denial-errors.js";
import {
  ReadFileInput,
  ReadFileOutput,
  WriteFileInput,
  WriteFileOutput,
  EditFileInput,
  EditFileOutput,
  GrepInput,
  GrepOutput,
  GrepMatch,
  GlobInput,
  GlobOutput,
  ListDirectoryInput,
  ListDirectoryOutput,
  DirectoryEntry,
} from "./types.js";

const MAX_READ_FILE_BYTES = 25 * 1024 * 1024; // 25MB safety boundary

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf",
  ".zip", ".tar", ".gz", ".7z", ".dmg", ".pkg", ".bin",
  ".dylib", ".so", ".node", ".exe", ".lock", ".woff", ".woff2", ".ttf", ".eot"
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  ".opensand-snapshots",
]);

export function resolveAndValidatePath(
  targetPath: string,
  workspaceRoot?: string,
  allowOutsideWorkspace?: boolean
): string {
  const root = workspaceRoot ? path.resolve(workspaceRoot) : undefined;
  const resolved = root && !path.isAbsolute(targetPath) ? path.resolve(root, targetPath) : path.resolve(targetPath);

  if (root && !allowOutsideWorkspace) {
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new WorkspaceEscapeError(`Path traversal blocked: target path "${targetPath}" resolves outside workspace root "${root}".`);
    }
  }

  return resolved;
}

export async function readFileOperation(input: ReadFileInput): Promise<ReadFileOutput> {
  const resolvedPath = resolveAndValidatePath(input.path, input.workspaceRoot, input.allowOutsideWorkspace);
  const stat = await fs.stat(resolvedPath);
  if (stat.size > MAX_READ_FILE_BYTES) {
    throw new Error(
      `File size (${(stat.size / (1024 * 1024)).toFixed(1)}MB) exceeds maximum safe read limit (25MB): ${resolvedPath}`
    );
  }
  const ext = path.extname(resolvedPath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    throw new Error(
      `Cannot read binary file (${ext}) as text: ${resolvedPath}. For images, use recognize_screen_text or inspect via shell.`
    );
  }

  const rawBytes = await fs.readFile(resolvedPath);
  // Null-byte check on first 1KB
  const checkSlice = rawBytes.subarray(0, Math.min(1024, rawBytes.byteLength));
  if (checkSlice.includes(0)) {
    throw new Error(
      `Cannot read binary file (detected null bytes) as text: ${resolvedPath}.`
    );
  }
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
  } else {
    // Default safety bounding: cap unbounded reads at 800 lines to prevent token blowup
    const DEFAULT_MAX_LINES = 800;
    if (totalLines > DEFAULT_MAX_LINES) {
      selectedContent =
        lines.slice(0, DEFAULT_MAX_LINES).join("\n") +
        `\n\n[... File truncated: showing lines 1-${DEFAULT_MAX_LINES} of ${totalLines} (${rawBytes.byteLength.toLocaleString()} bytes). Pass start_line and end_line arguments to read further sections. ...]`;
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
  const resolvedPath = resolveAndValidatePath(input.path, input.workspaceRoot, input.allowOutsideWorkspace);
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

export async function editFileOperation(input: EditFileInput): Promise<EditFileOutput> {
  const resolvedPath = resolveAndValidatePath(input.path, input.workspaceRoot, input.allowOutsideWorkspace);

  if (input.old_string === input.new_string) {
    throw new Error("old_string and new_string must be different.");
  }

  const rawBytes = await fs.readFile(resolvedPath);
  const checkSlice = rawBytes.subarray(0, Math.min(1024, rawBytes.byteLength));
  if (checkSlice.includes(0)) {
    throw new Error(`Cannot edit binary file (detected null bytes): ${resolvedPath}.`);
  }

  const content = rawBytes.toString("utf-8");

  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(input.old_string, pos)) !== -1) {
    count++;
    pos += input.old_string.length;
  }

  if (count === 0) {
    throw new Error(`String to replace was not found in file: "${resolvedPath}".`);
  }

  if (count > 1 && !input.replace_all) {
    throw new Error(
      `old_string matches ${count} times in "${resolvedPath}". Specify replace_all: true to replace all instances or provide a unique string.`
    );
  }

  let newContent: string;
  let replacementCount: number;
  if (input.replace_all) {
    newContent = content.split(input.old_string).join(input.new_string);
    replacementCount = count;
  } else {
    newContent = content.replace(input.old_string, input.new_string);
    replacementCount = 1;
  }

  const parentDir = path.dirname(resolvedPath);
  await fs.mkdir(parentDir, { recursive: true });
  const tempPath = path.join(parentDir, `.${path.basename(resolvedPath)}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const buffer = Buffer.from(newContent, "utf-8");
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
    replacementCount,
    sha256,
    bytesWritten: buffer.byteLength,
  };
}

export function compileGlobPattern(glob: string): RegExp {
  let regexStr = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          regexStr += "(?:.*\/)?";
          i += 3;
          continue;
        } else {
          regexStr += ".*";
          i += 2;
          continue;
        }
      } else {
        regexStr += "[^\/]*";
        i++;
        continue;
      }
    } else if (c === "?") {
      regexStr += "[^\/]";
      i++;
      continue;
    } else if (["\\", ".", "+", "^", "$", "(", ")", "[", "]", "{", "}", "|"].includes(c)) {
      regexStr += "\\" + c;
      i++;
      continue;
    } else {
      regexStr += c;
      i++;
      continue;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

export async function grepOperation(input: GrepInput): Promise<GrepOutput> {
  const resolvedPath = resolveAndValidatePath(input.path || ".", input.workspaceRoot, input.allowOutsideWorkspace);
  const maxResults = input.max_results ?? 200;

  let regex: RegExp;
  try {
    const flags = input.case_insensitive ? "i" : "";
    regex = new RegExp(input.pattern, flags);
  } catch (err: any) {
    throw new Error(`Invalid regex pattern "${input.pattern}": ${err.message}`);
  }

  const globMatcher = input.glob ? compileGlobPattern(input.glob) : null;
  const matches: GrepMatch[] = [];
  const linesOutput: string[] = [];
  let truncated = false;

  async function searchFile(filePath: string) {
    if (truncated) return;
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return;

    const relToResolved = path.relative(resolvedPath, filePath).split(path.sep).join("/");
    if (globMatcher) {
      const fileName = path.basename(filePath);
      if (!globMatcher.test(relToResolved) && !globMatcher.test(fileName)) {
        return;
      }
    }

    let stat;
    try {
      stat = await fs.stat(filePath);
      if (stat.size > MAX_READ_FILE_BYTES) return;
    } catch {
      return;
    }

    let rawBytes: Buffer;
    try {
      rawBytes = await fs.readFile(filePath);
    } catch {
      return;
    }

    const checkSlice = rawBytes.subarray(0, Math.min(1024, rawBytes.byteLength));
    if (checkSlice.includes(0)) return;

    const text = rawBytes.toString("utf-8");
    const fileLines = text.split("\n");
    for (let idx = 0; idx < fileLines.length; idx++) {
      const lineText = fileLines[idx];
      if (regex.test(lineText)) {
        matches.push({
          file: relToResolved || path.basename(filePath),
          line: idx + 1,
          text: lineText,
        });
        linesOutput.push(`${relToResolved || path.basename(filePath)}:${idx + 1}:${lineText}`);
        if (matches.length >= maxResults) {
          truncated = true;
          return;
        }
      }
    }
  }

  async function walkDir(currentDir: string) {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (truncated) return;
      if (ent.isDirectory()) {
        if (!IGNORED_DIRECTORY_NAMES.has(ent.name)) {
          await walkDir(path.join(currentDir, ent.name));
        }
      } else if (ent.isFile()) {
        await searchFile(path.join(currentDir, ent.name));
      }
    }
  }

  const stat = await fs.stat(resolvedPath);
  if (stat.isDirectory()) {
    await walkDir(resolvedPath);
  } else if (stat.isFile()) {
    await searchFile(resolvedPath);
  }

  return {
    matches,
    lines: linesOutput,
    totalMatches: matches.length,
    truncated,
  };
}

export async function globOperation(input: GlobInput): Promise<GlobOutput> {
  const resolvedPath = resolveAndValidatePath(input.path || ".", input.workspaceRoot, input.allowOutsideWorkspace);
  const maxResults = input.max_results ?? 200;
  const matcher = compileGlobPattern(input.pattern);

  const matches: string[] = [];
  let truncated = false;

  async function walk(currentDir: string) {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (truncated) return;
      const fullPath = path.join(currentDir, ent.name);
      const relPath = path.relative(resolvedPath, fullPath).split(path.sep).join("/");

      if (matcher.test(relPath) || matcher.test(ent.name)) {
        matches.push(relPath);
        if (matches.length >= maxResults) {
          truncated = true;
          return;
        }
      }

      if (ent.isDirectory() && !IGNORED_DIRECTORY_NAMES.has(ent.name)) {
        await walk(fullPath);
      }
    }
  }

  const stat = await fs.stat(resolvedPath);
  if (stat.isDirectory()) {
    await walk(resolvedPath);
  }

  return {
    matches,
    totalMatches: matches.length,
    truncated,
  };
}

export async function listDirectoryOperation(input: ListDirectoryInput): Promise<ListDirectoryOutput> {
  const resolvedPath = resolveAndValidatePath(input.path, input.workspaceRoot, input.allowOutsideWorkspace);
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
