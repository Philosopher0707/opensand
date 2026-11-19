import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * The push manifest (docs/design/phase8-reach.md §5.3).
 *
 * At push time the manifest records every workspace entry the mission pushed:
 * its content sha256, executable bit and symlink target. Apply later compares
 * the staging tree against it, so a local edit made while the agent worked
 * remotely is a conflict, never an overwrite. Keys are "/"-separated relative
 * paths so one manifest reads the same on macOS and the Linux host.
 * `.git` is excluded everywhere; the same symlink-escape rule as
 * `file-ops.ts` (resolveTargetPath) applies.
 */

export const MAX_MANIFEST_ENTRIES = 100_000;
/** 2 GB cap on the synced tree (design §5.4). */
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024 * 1024;

export interface ManifestEntry {
  /** Content sha256; null for a symlink. */
  hash: string | null;
  executable: boolean;
  /** Raw link target text for a symlink; absent for a regular file. */
  symlink?: string;
}

export interface WorkspaceManifest {
  version: 1;
  /** Absolute workspace root the manifest was built from. */
  root: string;
  entries: Record<string, ManifestEntry>;
}

export class ManifestError extends Error {
  /** The design reason prefix, e.g. "target-workspace-too-large". */
  public readonly reason: string;

  constructor(reason: string, message: string) {
    super(`${reason}: ${message}`);
    this.name = "ManifestError";
    this.reason = reason;
  }
}

export function sha256File(filePath: string): Promise<string> {  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Single-quote a value for a POSIX shell command (remote exec paths). */
export function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Walk `root` and build the manifest. Throws `target-symlink-escape` when any
 * symlink resolves outside the root (the file-ops.ts rule: resolve the real
 * target, refuse anything not under the root's real path), and
 * `target-workspace-too-large` past the entry or byte cap. Both refusals
 * happen before any push, so a rejected tree never leaves the machine.
 */
export async function buildManifest(
  root: string,
  limits: { maxEntries?: number; maxBytes?: number } = {},
): Promise<WorkspaceManifest> {
  const maxEntries = limits.maxEntries ?? MAX_MANIFEST_ENTRIES;
  const maxBytes = limits.maxBytes ?? MAX_MANIFEST_BYTES;
  const rootReal = await fsp.realpath(path.resolve(root));
  const entries: Record<string, ManifestEntry> = {};
  let totalBytes = 0;

  const visit = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (depth > 200) throw new ManifestError("target-symlink-escape", `directory nesting deeper than 200 under ${relDir}`);
    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const dirent of dirents) {
      if (dirent.name === ".git") continue; // excluded from every sync surface
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      if (entries[rel] !== undefined) continue;
      const abs = path.join(absDir, dirent.name);
      if (dirent.isSymbolicLink()) {
        const raw = await fsp.readlink(abs);
        const absTarget = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(abs), raw);
        let realTarget: string;
        try {
          realTarget = await fsp.realpath(absTarget);
        } catch {
          realTarget = absTarget; // dangling: fall back to the lexical target
        }
        const relTarget = path.relative(rootReal, realTarget);
        if (relTarget.startsWith("..") || path.isAbsolute(relTarget)) {
          throw new ManifestError(
            "target-symlink-escape",
            `symlink "${rel}" -> ${raw} resolves outside the workspace root "${root}"`,
          );
        }
        entries[rel] = { hash: null, executable: false, symlink: raw };
        continue;
      }
      if (dirent.isDirectory()) {
        await visit(abs, rel, depth + 1); // directories are walk artifacts, not entries
        continue;
      }
      if (!dirent.isFile()) continue; // sockets/fifos are not syncable
      const hash = await sha256File(abs);
      const stat = await fsp.stat(abs);
      entries[rel] = { hash, executable: (stat.mode & 0o111) !== 0 };
      totalBytes += stat.size;
      if (totalBytes > maxBytes) {
        throw new ManifestError("target-workspace-too-large", `tree exceeds the ${maxBytes} byte cap at "${rel}"`);
      }
      if (Object.keys(entries).length > maxEntries) {
        throw new ManifestError("target-workspace-too-large", `tree exceeds the ${maxEntries} entry cap at "${rel}"`);
      }
    }
  };

  await visit(rootReal, "", 0);
  return { version: 1, root: rootReal, entries };
}

/** Directories are walk artifacts, not syncable entries; every recorded entry is a file or a symlink. */
export function isFileEntry(entry: ManifestEntry | undefined): entry is ManifestEntry {
  return entry !== undefined;
}

export async function writeManifest(filePath: string, manifest: WorkspaceManifest): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(manifest), "utf8");
}

export async function readManifest(filePath: string): Promise<WorkspaceManifest> {
  const content = await fsp.readFile(filePath, "utf8");
  const value = JSON.parse(content) as WorkspaceManifest;
  if (value?.version !== 1 || typeof value.entries !== "object" || value.entries === null) {
    throw new ManifestError("target-manifest-invalid", `${filePath} is not a v1 manifest`);
  }
  return value;
}

/** Hash of one local entry as the manifest would record it (used by apply). */
export interface LocalEntryState {
  missing: boolean;
  hash: string | null;
  executable: boolean;
  symlink?: string;
}

export async function localEntryState(workspaceRoot: string, relPath: string): Promise<LocalEntryState> {
  const abs = path.join(workspaceRoot, ...relPath.split("/"));
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(abs);
  } catch {
    return { missing: true, hash: null, executable: false };
  }
  if (stat.isSymbolicLink()) {
    const raw = await fsp.readlink(abs);
    return { missing: false, hash: null, executable: false, symlink: raw };
  }
  if (!stat.isFile()) return { missing: false, hash: "", executable: false }; // directory: not comparable
  return { missing: false, hash: await sha256File(abs), executable: (stat.mode & 0o111) !== 0 };
}
