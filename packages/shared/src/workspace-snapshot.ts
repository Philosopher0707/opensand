import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface FileSnapshot {
  relPath: string;
  sha256: string;
  size: number;
}

export interface WorkspaceSnapshotManifest {
  turnId: string;
  timestamp: string;
  files: FileSnapshot[];
  skipped?: boolean;
  skipReason?: string;
}

export interface RevertResult {
  restored: string[];
  deleted: string[];
  unmodified: string[];
}

export interface SnapshotGuardOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
}

export interface RestorePoint {
  id: string;
  timestamp: string;
  filesCount: number;
  skipped?: boolean;
  skipReason?: string;
}

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100MB

function computeSha256(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function collectFiles(
  dir: string,
  baseDir: string = dir,
  ignoreDirs = new Set([".git", "node_modules", ".opensand-snapshots", "dist"])
): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoreDirs.has(entry.name)) {
        results.push(...collectFiles(path.join(dir, entry.name), baseDir, ignoreDirs));
      }
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      results.push(path.relative(baseDir, path.join(dir, entry.name)));
    }
  }

  return results;
}

/**
 * Creates a backup snapshot of a workspace directory for a specific turn.
 * Includes size and file-count safety guards to avoid token/disk blowups on huge workspaces.
 */
export function createWorkspaceSnapshot(
  workspaceDir: string,
  turnId: string,
  storageDir?: string,
  options?: SnapshotGuardOptions
): WorkspaceSnapshotManifest {
  const baseBackupDir = storageDir || path.join(workspaceDir, ".opensand-snapshots");
  const turnBackupDir = path.join(baseBackupDir, turnId);
  fs.mkdirSync(turnBackupDir, { recursive: true });

  const relPaths = collectFiles(workspaceDir);
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  // 1. File count guard
  if (relPaths.length > maxFiles) {
    const skipReason = `Workspace file count (${relPaths.length}) exceeds snapshot limit (${maxFiles})`;
    const manifest: WorkspaceSnapshotManifest = {
      turnId,
      timestamp: new Date().toISOString(),
      files: [],
      skipped: true,
      skipReason,
    };
    fs.writeFileSync(path.join(turnBackupDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    return manifest;
  }

  // 2. Total bytes guard
  let totalBytes = 0;
  for (const rel of relPaths) {
    const srcPath = path.join(workspaceDir, rel);
    try {
      const stat = fs.statSync(srcPath);
      totalBytes += stat.size;
    } catch {
      // Ignore stat error for ephemeral files
    }
  }

  if (totalBytes > maxTotalBytes) {
    const skipReason = `Workspace total size (${(totalBytes / (1024 * 1024)).toFixed(1)}MB) exceeds snapshot limit (${(maxTotalBytes / (1024 * 1024)).toFixed(0)}MB)`;
    const manifest: WorkspaceSnapshotManifest = {
      turnId,
      timestamp: new Date().toISOString(),
      files: [],
      skipped: true,
      skipReason,
    };
    fs.writeFileSync(path.join(turnBackupDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    return manifest;
  }

  // 3. Normal snapshot creation
  const files: FileSnapshot[] = [];
  for (const rel of relPaths) {
    const srcPath = path.join(workspaceDir, rel);
    const destPath = path.join(turnBackupDir, "files", rel);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);

    const hash = computeSha256(srcPath);
    const stat = fs.statSync(srcPath);
    files.push({
      relPath: rel,
      sha256: hash,
      size: stat.size,
    });
  }

  const manifest: WorkspaceSnapshotManifest = {
    turnId,
    timestamp: new Date().toISOString(),
    files,
    skipped: false,
  };

  fs.writeFileSync(path.join(turnBackupDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

/**
 * Reverts the workspace directory to the exact state captured in the snapshot turnId.
 */
export function revertWorkspaceSnapshot(
  workspaceDir: string,
  turnId: string,
  storageDir?: string
): RevertResult {
  const baseBackupDir = storageDir || path.join(workspaceDir, ".opensand-snapshots");
  const turnBackupDir = path.join(baseBackupDir, turnId);
  const manifestPath = path.join(turnBackupDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Snapshot manifest not found for turn: ${turnId}`);
  }

  const manifest: WorkspaceSnapshotManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.skipped) {
    throw new Error(
      `Cannot revert to snapshot "${turnId}": snapshot was skipped (${manifest.skipReason || "limit exceeded"}).`
    );
  }

  const snapshotFiles = new Map<string, FileSnapshot>(manifest.files.map((f) => [f.relPath, f]));
  const currentFiles = collectFiles(workspaceDir);
  const restored: string[] = [];
  const deleted: string[] = [];
  const unmodified: string[] = [];

  // 1. Remove files that did not exist in the snapshot
  for (const rel of currentFiles) {
    if (!snapshotFiles.has(rel)) {
      const fullPath = path.join(workspaceDir, rel);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        deleted.push(rel);
      }
    }
  }

  // 2. Restore modified or missing files from snapshot
  for (const snap of manifest.files) {
    const currentPath = path.join(workspaceDir, snap.relPath);
    const backupPath = path.join(turnBackupDir, "files", snap.relPath);

    let needsRestore = false;
    if (!fs.existsSync(currentPath)) {
      needsRestore = true;
    } else {
      const currentHash = computeSha256(currentPath);
      if (currentHash !== snap.sha256) {
        needsRestore = true;
      } else {
        unmodified.push(snap.relPath);
      }
    }

    if (needsRestore && fs.existsSync(backupPath)) {
      fs.mkdirSync(path.dirname(currentPath), { recursive: true });
      fs.copyFileSync(backupPath, currentPath);
      restored.push(snap.relPath);
    }
  }

  return { restored, deleted, unmodified };
}

/**
 * List all saved restore points for a workspace.
 */
export function listWorkspaceSnapshots(
  workspaceDir: string,
  storageDir?: string
): RestorePoint[] {
  const baseBackupDir = storageDir || path.join(workspaceDir, ".opensand-snapshots");
  if (!fs.existsSync(baseBackupDir)) return [];
  const entries = fs.readdirSync(baseBackupDir, { withFileTypes: true });
  const results: RestorePoint[] = [];

  for (const ent of entries) {
    if (ent.isDirectory()) {
      const manifestPath = path.join(baseBackupDir, ent.name, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        try {
          const m: WorkspaceSnapshotManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          results.push({
            id: m.turnId,
            timestamp: m.timestamp,
            filesCount: m.files?.length ?? 0,
            skipped: m.skipped,
            skipReason: m.skipReason,
          });
        } catch {
          // Skip corrupt manifests
        }
      }
    }
  }

  return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
