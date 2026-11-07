import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface FileSnapshot {
  relPath: string;
  sha256: string;
  size: number;
}

export interface WorkspaceSnapshotManifest {
  turnId: string;
  timestamp: string;
  files: FileSnapshot[];
}

export interface RevertResult {
  restored: string[];
  deleted: string[];
  unmodified: string[];
}

function computeSha256(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function collectFiles(dir: string, baseDir: string = dir, ignoreDirs = new Set(['.git', 'node_modules', '.opensand-snapshots', 'dist'])): string[] {
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
 */
export function createWorkspaceSnapshot(workspaceDir: string, turnId: string, storageDir?: string): WorkspaceSnapshotManifest {
  const baseBackupDir = storageDir || path.join(workspaceDir, '.opensand-snapshots');
  const turnBackupDir = path.join(baseBackupDir, turnId);
  fs.mkdirSync(turnBackupDir, { recursive: true });

  const relPaths = collectFiles(workspaceDir);
  const files: FileSnapshot[] = [];

  for (const rel of relPaths) {
    const srcPath = path.join(workspaceDir, rel);
    const destPath = path.join(turnBackupDir, 'files', rel);
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
  };

  fs.writeFileSync(path.join(turnBackupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/**
 * Reverts the workspace directory to the exact state captured in the snapshot turnId.
 */
export function revertWorkspaceSnapshot(workspaceDir: string, turnId: string, storageDir?: string): RevertResult {
  const baseBackupDir = storageDir || path.join(workspaceDir, '.opensand-snapshots');
  const turnBackupDir = path.join(baseBackupDir, turnId);
  const manifestPath = path.join(turnBackupDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Snapshot manifest not found for turn: ${turnId}`);
  }

  const manifest: WorkspaceSnapshotManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const snapshotFiles = new Map<string, FileSnapshot>(manifest.files.map(f => [f.relPath, f]));

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
    const backupPath = path.join(turnBackupDir, 'files', snap.relPath);

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
