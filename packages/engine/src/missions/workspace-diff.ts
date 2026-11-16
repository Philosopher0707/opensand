export function cleanGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) {
      env[k] = v;
    }
  }
  return env;
}

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { ErrorCodes, OspError } from "@opensand/protocol";
import { runCommandOperation } from "@opensand/local-exec-daemon";

export interface TreeResult {
  available: boolean;
  tree?: string;
  reason?: string;
}

export interface FileChanges {
  file: string;
  /** New-side line ranges touched by the diff, inclusive on both ends. */
  ranges: [number, number][];
  /** Old-side start line of content that the diff deleted outright. */
  deletedAt?: number[];
}

export type ChangesResult = FileChanges[] | { available: false; reason: string };

export async function isGitRepository(workspaceRoot: string): Promise<boolean> {
  try {
    const res = await runCommandOperation({
      command: "git rev-parse --is-inside-work-tree",
      cwd: workspaceRoot,
      workspaceRoot,
      env: cleanGitEnv(),
    });
    return res.exitCode === 0 && res.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Builds a git tree id from a temporary index so that the user's index,
 * branch and stash are untouched.
 */
export async function treeOf(workspaceRoot: string): Promise<TreeResult> {
  const isGit = await isGitRepository(workspaceRoot);
  if (!isGit) {
    return { available: false, reason: "not a git repository" };
  }

  const tmpIndex = path.join(os.tmpdir(), `opensand-git-idx-${randomUUID()}`);
  try {
    const res = await runCommandOperation({
      command: "git add -A && git write-tree",
      cwd: workspaceRoot,
      workspaceRoot,
      env: { ...cleanGitEnv(), GIT_INDEX_FILE: tmpIndex },
    });

    if (res.exitCode !== 0) {
      return { available: false, reason: res.stderr.trim() || "git write-tree failed" };
    }

    const outputLines = res.stdout.trim().split("\n");
    const tree = outputLines[outputLines.length - 1]?.trim();
    if (!tree) {
      return { available: false, reason: "no tree id returned" };
    }

    return { available: true, tree };
  } finally {
    try {
      if (fs.existsSync(tmpIndex)) {
        fs.unlinkSync(tmpIndex);
      }
    } catch {
      // Ignore cleanup error
    }
  }
}

function stripPathPrefix(path: string): string {
  return path.replace(/^[a-z]\//, "");
}

/**
 * Parses `git diff --unified=0` output into per-file new-side line ranges.
 * Content the diff removed has no new-side range, so it is recorded as
 * deletedAt with the old-side start line.
 */
export function changedLines(diffText: string): FileChanges[] {
  const files: FileChanges[] = [];
  let currentFile: FileChanges | null = null;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const parts = line.slice("diff --git ".length).split(" ");
      currentFile = { file: stripPathPrefix(parts[1] ?? ""), ranges: [] };
      files.push(currentFile);
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith("rename to ")) {
      currentFile.file = stripPathPrefix(line.slice("rename to ".length).trim());
      continue;
    }

    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target !== "/dev/null") {
        currentFile.file = stripPathPrefix(target);
      }
      continue;
    }

    if (line.startsWith("--- ")) {
      const source = line.slice(4).trim();
      if (source !== "/dev/null" && (!currentFile.file || currentFile.file === "/dev/null")) {
        currentFile.file = stripPathPrefix(source);
      }
      continue;
    }

    // @@ -oldStart[,oldCount] +newStart[,newCount] @@
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      const oldStart = parseInt(match[1], 10);
      const newStart = parseInt(match[3], 10);
      const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;

      if (newCount === 0) {
        if (!currentFile.deletedAt) currentFile.deletedAt = [];
        currentFile.deletedAt.push(oldStart);
      } else {
        const start = newStart;
        const end = newStart + newCount - 1;
        currentFile.ranges.push([start, end]);
      }
    }
  }

  return files.filter(
    (file) => file.file !== "" && (file.ranges.length > 0 || (file.deletedAt?.length ?? 0) > 0)
  );
}

/**
 * Changed lines between two trees of the same repository, as new-side ranges.
 */
export async function changedLinesBetweenTrees(
  baseTree: string,
  finalTree: string,
  workspaceRoot: string
): Promise<ChangesResult> {
  if (!(await isGitRepository(workspaceRoot))) {
    return { available: false, reason: "not a git repository" };
  }

  const res = await runCommandOperation({
    command: `git diff --unified=0 --no-color ${baseTree} ${finalTree}`,
    cwd: workspaceRoot,
    workspaceRoot,
    env: cleanGitEnv(),
  });

  if (res.exitCode !== 0) {
    return { available: false, reason: res.stderr.trim() || "git diff failed" };
  }

  return changedLines(res.stdout);
}

const SAFE_REF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Pins the mission's base and final trees under refs the engine owns, so `git gc` cannot prune
 * them while the mission's diff is still viewable. Returns only the ids that exist and were pinned.
 */
export async function pinTrees(
  workspaceRoot: string,
  missionId: string,
  baseTree?: string,
  finalTree?: string
): Promise<{ baseTree?: string; finalTree?: string }> {
  const out: { baseTree?: string; finalTree?: string } = {};
  if (!SAFE_REF_ID.test(missionId) || missionId.endsWith(".lock") || missionId.includes("..")) return out;
  for (const [key, id, name] of [["baseTree", baseTree, "base"], ["finalTree", finalTree, "final"]] as const) {
    if (!id || !/^[0-9a-f]{40,64}$/.test(id)) continue;
    try {
      const res = await runCommandOperation({
        command: `git update-ref refs/opensand/missions/${missionId}/${name} ${id}`,
        cwd: workspaceRoot,
        workspaceRoot,
        // A git hook exports these; the ref belongs in the workspace's own repository.
        env: cleanGitEnv() as any,
      });
      if (res.exitCode === 0) out[key] = id;
    } catch {
      // not a git repository or ref refused: the id is not recorded, the viewer shows "not available"
    }
  }
  return out;
}

/**
 * Sanitizes a string for use as a ref path component, adhering to git check-ref-format rules:
 * - Cannot begin with '.' or end with '.' or '.lock'
 * - Cannot contain '..'
 * - Cannot contain control characters, space, '~', '^', ':', '?', '*', '[', '@{', '\', '/'
 */
export function sanitizeRefName(name: string): string {
  let s = name.trim();
  s = s.replace(/[^A-Za-z0-9._-]/g, "-");
  s = s.replace(/\.{2,}/g, ".");
  s = s.replace(/^\.+/, "").replace(/\.+$/, "");
  while (s.endsWith(".lock")) {
    s = s.slice(0, -5).replace(/\.+$/, "");
  }
  s = s.replace(/^-+/, "");
  if (!s) {
    s = "mission";
  }
  return s;
}

export interface StepSnapshotResult {
  ref: string;
  tree: string;
}

/**
 * Captures a hidden git ref snapshot of the workspace before a mutating mission step.
 * Uses a temporary index file so the user's index, branch, and stash are completely untouched.
 */
export async function createStepSnapshot(
  workspaceRoot: string,
  missionId: string,
  seq: number | string
): Promise<StepSnapshotResult | null> {
  try {
    const isGit = await isGitRepository(workspaceRoot);
    if (!isGit) {
      return null;
    }

    const cleanMission = sanitizeRefName(missionId);
    const cleanSeq = String(seq).trim().replace(/[^A-Za-z0-9_-]/g, "");
    if (!cleanSeq) {
      console.error(`[createStepSnapshot] invalid seq for mission ${missionId}: ${seq}`);
      return null;
    }

    const ref = `refs/opensand/missions/${cleanMission}/s-${cleanSeq}`;

    const treeRes = await treeOf(workspaceRoot);
    if (!treeRes.available || !treeRes.tree) {
      console.error(`[createStepSnapshot] treeOf failed for ${ref}: ${treeRes.reason}`);
      return null;
    }

    const commitRes = await runCommandOperation({
      command: `git -c user.name=OpenSand -c user.email=opensand@local -c commit.gpgsign=false commit-tree ${treeRes.tree} -m "snapshot s-${cleanSeq}"`,
      cwd: workspaceRoot,
      workspaceRoot,
      env: cleanGitEnv(),
    });

    if (commitRes.exitCode !== 0) {
      console.error(`[createStepSnapshot] git commit-tree failed for ${ref}: ${commitRes.stderr}`);
      return null;
    }

    const commitHash = commitRes.stdout.trim().split("\n").pop()?.trim();
    if (!commitHash || !/^[0-9a-f]{40,64}$/.test(commitHash)) {
      console.error(`[createStepSnapshot] invalid commit hash for ${ref}: ${commitRes.stdout}`);
      return null;
    }

    const updateRes = await runCommandOperation({
      command: `git update-ref ${ref} ${commitHash}`,
      cwd: workspaceRoot,
      workspaceRoot,
      env: cleanGitEnv(),
    });

    if (updateRes.exitCode !== 0) {
      console.error(`[createStepSnapshot] git update-ref failed for ${ref}: ${updateRes.stderr}`);
      return null;
    }

    return { ref, tree: treeRes.tree };
  } catch (err) {
    console.error(`[createStepSnapshot] exception for mission ${missionId} step ${seq}:`, err);
    return null;
  }
}


export interface RestoreOptions {
  cleanMissionId?: string;
  skipPreRestoreSnapshot?: boolean;
  _simulateFailure?: "checkout" | "unlink";
}

export interface RestorePreviewResult {
  targetRef: string;
  targetTree: string;
  overwrittenFiles: string[];
  restoredFiles: string[];
  deletedFiles: string[];
  skippedSubmodules: string[];
}

export interface RestoreExecutionSummary {
  restoredSnapshot: string;
  preRestoreSnapshot: string;
  targetTree: string;
  restoredFilesCount: number;
  deletedFilesCount: number;
  restoredFiles: string[];
  overwrittenFiles: string[];
  deletedFiles: string[];
  skippedSubmodules: string[];
}

export interface TreeSafetyResult {
  valid: boolean;
  reason?: string;
  errorCode?: number;
  paths: string[];
  submodules: string[];
}

function pruneEmptyParentDirs(root: string, dir: string) {
  let cur = path.resolve(dir);
  const resolvedRoot = path.resolve(root);
  while (cur !== resolvedRoot && cur.startsWith(resolvedRoot + path.sep)) {
    try {
      const files = fs.readdirSync(cur);
      if (files.length === 0) {
        fs.rmdirSync(cur);
        cur = path.dirname(cur);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

/**
 * Validates tree safety against directory traversal, symlink escapes,
 * directory symlinks along target paths (C3), and macOS case collisions.
 */
export async function validateTreeSafety(
  workspaceRoot: string,
  treeSha: string
): Promise<TreeSafetyResult> {
  const isGit = await isGitRepository(workspaceRoot);
  if (!isGit) {
    return {
      valid: false,
      reason: "Workspace is not a git repository",
      errorCode: ErrorCodes.InvalidParams,
      paths: [],
      submodules: [],
    };
  }

  const res = await runCommandOperation({
    command: `git ls-tree -r -z "${treeSha}"`,
    cwd: workspaceRoot,
    workspaceRoot,
    env: cleanGitEnv(),
  });

  if (res.exitCode !== 0) {
    return {
      valid: false,
      reason: `Failed to inspect tree ${treeSha}: ${res.stderr.trim()}`,
      errorCode: ErrorCodes.InvalidParams,
      paths: [],
      submodules: [],
    };
  }

  const paths: string[] = [];
  const submodules: string[] = [];
  const entries = res.stdout.split("\0").filter((e) => e.length > 0);

  for (const entry of entries) {
    const tabIdx = entry.indexOf("\t");
    if (tabIdx === -1) continue;
    const meta = entry.slice(0, tabIdx);
    const relPath = entry.slice(tabIdx + 1);
    const [mode, type, sha] = meta.split(" ");

    // Submodules (mode 160000 per C5)
    if (mode === "160000") {
      submodules.push(relPath);
      continue;
    }

    // Risk 6: Path traversal check (.. or absolute paths)
    if (
      relPath.includes("..") ||
      path.isAbsolute(relPath) ||
      relPath.startsWith("/") ||
      relPath.startsWith("\\")
    ) {
      return {
        valid: false,
        reason: `Path traversal detected in snapshot tree: ${relPath}`,
        errorCode: ErrorCodes.InvalidParams,
        paths: [],
        submodules: [],
      };
    }

    const canonRoot = path.resolve(workspaceRoot);
    const resolved = path.resolve(workspaceRoot, relPath);
    if (resolved !== canonRoot && !resolved.startsWith(canonRoot + path.sep)) {
      return {
        valid: false,
        reason: `Path traversal detected in snapshot tree: ${relPath}`,
        errorCode: ErrorCodes.InvalidParams,
        paths: [],
        submodules: [],
      };
    }

    // Risk 6: Symlink escape attacks (mode 120000)
    if (mode === "120000") {
      const blobRes = await runCommandOperation({
        command: `git cat-file -p "${sha}"`,
        cwd: workspaceRoot,
        workspaceRoot,
        env: cleanGitEnv(),
      });
      if (blobRes.exitCode !== 0) {
        return {
          valid: false,
          reason: `Failed to read symlink blob ${sha}`,
          errorCode: ErrorCodes.InvalidParams,
          paths: [],
          submodules: [],
        };
      }
      const symlinkTarget = blobRes.stdout.trim();
      if (path.isAbsolute(symlinkTarget)) {
        return {
          valid: false,
          reason: `Symlink target is absolute: ${symlinkTarget}`,
          errorCode: ErrorCodes.InvalidParams,
          paths: [],
          submodules: [],
        };
      }
      const symlinkResolved = path.resolve(path.dirname(resolved), symlinkTarget);
      if (
        symlinkResolved !== canonRoot &&
        !symlinkResolved.startsWith(canonRoot + path.sep)
      ) {
        return {
          valid: false,
          reason: `Symlink target escapes workspaceRoot: ${symlinkTarget}`,
          errorCode: ErrorCodes.InvalidParams,
          paths: [],
          submodules: [],
        };
      }
    }

    paths.push(relPath);
  }

  // Risk 6: macOS Case-Insensitive Filesystems collision check
  if (process.platform === "darwin") {
    const lowerMap = new Map<string, string>();
    for (const p of paths) {
      const lower = p.toLowerCase();
      if (lowerMap.has(lower)) {
        const existing = lowerMap.get(lower)!;
        if (existing !== p) {
          return {
            valid: false,
            reason: `Case-folding collision detected between '${existing}' and '${p}' on case-insensitive filesystem`,
            errorCode: ErrorCodes.InvalidRequest,
            paths: [],
            submodules: [],
          };
        }
      }
      lowerMap.set(lower, p);
    }
  }

  // C3: Never delete a symlink in the workspace. If a directory along a target path is a symlink,
  // refuse the whole restore before writing anything, and name the path in the error.
  for (const p of paths) {
    const parts = p.split(/[\/\\]/);
    let cur = path.resolve(workspaceRoot);
    for (let i = 0; i < parts.length - 1; i++) {
      cur = path.join(cur, parts[i]);
      try {
        const stat = fs.lstatSync(cur);
        if (stat.isSymbolicLink()) {
          const relSeg = path.relative(workspaceRoot, cur);
          return {
            valid: false,
            reason: `Refusing restore: directory along target path is a symlink: ${relSeg}`,
            errorCode: ErrorCodes.InvalidRequest,
            paths: [],
            submodules: [],
          };
        }
      } catch {
        // Path segment does not exist on disk yet
      }
    }
  }

  return { valid: true, paths, submodules };
}

/**
 * Computes exact list of files to unlink:
 * In later mission step snapshots, absent in target, not in base-untracked, not ignored.
 * Per C1: F_later must be ONLY mission step snapshots s-j with j > targetSeq. Exclude pre-restore tree.
 */
export async function computeFilesToDelete(
  workspaceRoot: string,
  missionId: string,
  targetTreeSha: string,
  targetSeq: number | string | undefined,
  preRestoreTreeSha?: string
): Promise<string[]> {
  const cleanMission = sanitizeRefName(missionId);

  // 1. Files in target tree
  const targetLsRes = await runCommandOperation({
    command: `git ls-tree -r -z --name-only "${targetTreeSha}"`,
    cwd: workspaceRoot,
    workspaceRoot,
    env: cleanGitEnv(),
  });
  const targetFiles = new Set<string>(
    targetLsRes.stdout.split("\0").filter((f) => f.length > 0)
  );

  // 2. Compute F_later
  // Per C1: F_later must be ONLY mission step snapshots s-j with j > targetSeq. Exclude pre-restore tree.
  const filesInLaterSteps = new Set<string>();

  let targetSeqNumber: number | undefined;
  if (typeof targetSeq === "number") {
    targetSeqNumber = targetSeq;
  } else if (typeof targetSeq === "string") {
    const s = targetSeq.trim();
    if (/^\d+$/.test(s)) {
      targetSeqNumber = parseInt(s, 10);
    } else if (s.startsWith("s-")) {
      const rest = s.slice(2);
      if (/^\d+$/.test(rest)) {
        targetSeqNumber = parseInt(rest, 10);
      }
    }
  }

  if (targetSeqNumber !== undefined && !isNaN(targetSeqNumber)) {
    const refsRes = await runCommandOperation({
      command: `git for-each-ref --format="%(refname) %(objectname)" "refs/opensand/missions/${cleanMission}/s-*"`,
      cwd: workspaceRoot,
      workspaceRoot,
      env: cleanGitEnv(),
    });
    if (refsRes.exitCode === 0 && refsRes.stdout.trim()) {
      const lines = refsRes.stdout.trim().split("\n");
      for (const line of lines) {
        const parts = line.trim().split(" ");
        if (parts.length < 2) continue;
        const refname = parts[0];
        const sha = parts[1];
        const prefix = `refs/opensand/missions/${cleanMission}/s-`;
        if (refname.startsWith(prefix)) {
          const suffix = refname.slice(prefix.length);
          if (/^\d+$/.test(suffix)) {
            const stepNum = parseInt(suffix, 10);
            if (stepNum > targetSeqNumber) {
              const stepTreeRes = await runCommandOperation({
                command: `git rev-parse --verify "${sha}^{tree}"`,
                cwd: workspaceRoot,
                workspaceRoot,
                env: cleanGitEnv(),
              });
              if (stepTreeRes.exitCode === 0) {
                const stepTree = stepTreeRes.stdout.trim();
                const stepLsRes = await runCommandOperation({
                  command: `git ls-tree -r -z --name-only "${stepTree}"`,
                  cwd: workspaceRoot,
                  workspaceRoot,
                  env: cleanGitEnv(),
                });
                if (stepLsRes.exitCode === 0) {
                  for (const f of stepLsRes.stdout.split("\0")) {
                    if (f.length > 0) filesInLaterSteps.add(f);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // 3. Untracked files before the mission: T_base \ T_HEAD
  const untrackedPreFiles = new Set<string>();
  const baseRef = `refs/opensand/missions/${cleanMission}/base`;
  const baseTreeRes = await runCommandOperation({
    command: `git rev-parse --verify "${baseRef}^{tree}"`,
    cwd: workspaceRoot,
    workspaceRoot,
    env: cleanGitEnv(),
  });
  if (baseTreeRes.exitCode === 0) {
    const baseTree = baseTreeRes.stdout.trim();
    const baseLsRes = await runCommandOperation({
      command: `git ls-tree -r -z --name-only "${baseTree}"`,
      cwd: workspaceRoot,
      workspaceRoot,
      env: cleanGitEnv(),
    });
    const headTreeRes = await runCommandOperation({
      command: `git rev-parse --verify "HEAD^{tree}"`,
      cwd: workspaceRoot,
      workspaceRoot,
      env: cleanGitEnv(),
    });
    const headFiles = new Set<string>();
    if (headTreeRes.exitCode === 0) {
      const headTree = headTreeRes.stdout.trim();
      const headLsRes = await runCommandOperation({
        command: `git ls-tree -r -z --name-only "${headTree}"`,
        cwd: workspaceRoot,
        workspaceRoot,
        env: cleanGitEnv(),
      });
      if (headLsRes.exitCode === 0) {
        for (const f of headLsRes.stdout.split("\0")) {
          if (f.length > 0) headFiles.add(f);
        }
      }
    }

    if (baseLsRes.exitCode === 0) {
      for (const f of baseLsRes.stdout.split("\0")) {
        if (f.length > 0 && !headFiles.has(f)) {
          untrackedPreFiles.add(f);
        }
      }
    }
  }

  // 4. Filter candidates
  const filesToDelete: string[] = [];
  for (const file of filesInLaterSteps) {
    if (targetFiles.has(file)) continue;
    if (untrackedPreFiles.has(file)) continue;

    const fullPath = path.join(workspaceRoot, file);
    try {
      const stat = fs.lstatSync(fullPath);
      // C3: Never delete a symlink in the workspace
      if (stat.isSymbolicLink()) continue;
    } catch {
      continue; // File does not exist on disk
    }

    // Never delete ignored files
    const ignoreRes = await runCommandOperation({
      command: `git check-ignore -q -- "${file}"`,
      cwd: workspaceRoot,
      workspaceRoot,
      env: cleanGitEnv(),
    });
    if (ignoreRes.exitCode === 0) continue;

    filesToDelete.push(file);
  }

  return filesToDelete;
}

/**
 * Restores workspace files to match a step snapshot without modifying HEAD, index, branch, or stash.
 */
export interface ResolvedRestoreTarget {
  targetRef: string;
  targetSeqNumber?: number;
  targetTree: string;
  safety: TreeSafetyResult;
  overwrittenFiles: string[];
}

/**
 * Resolves snapshot identifier, verifies git repository, checks tree safety,
 * and collects files that would be overwritten by target blobs.
 * Shared by previewRestore and restoreSnapshot.
 */
export async function resolveAndValidateRestoreTarget(
  workspaceRoot: string,
  missionId: string,
  snapshotRefOrSeq: string | number
): Promise<ResolvedRestoreTarget> {
  const isGit = await isGitRepository(workspaceRoot);
  if (!isGit) {
    throw new OspError(ErrorCodes.InvalidParams, "Workspace is not a git repository");
  }

  const cleanMission = sanitizeRefName(missionId);
  let targetRef: string;
  let targetSeqNumber: number | undefined;

  if (typeof snapshotRefOrSeq === "number") {
    targetSeqNumber = snapshotRefOrSeq;
    targetRef = `refs/opensand/missions/${cleanMission}/s-${targetSeqNumber}`;
  } else {
    const s = String(snapshotRefOrSeq).trim();
    if (/^\d+$/.test(s)) {
      targetSeqNumber = parseInt(s, 10);
      targetRef = `refs/opensand/missions/${cleanMission}/s-${targetSeqNumber}`;
    } else if (s.startsWith("s-")) {
      const rest = s.slice(2);
      if (/^\d+$/.test(rest)) {
        targetSeqNumber = parseInt(rest, 10);
      }
      targetRef = `refs/opensand/missions/${cleanMission}/${s}`;
    } else if (s.startsWith("refs/opensand/missions/")) {
      const expectedPrefix = `refs/opensand/missions/${cleanMission}/`;
      if (!s.startsWith(expectedPrefix)) {
        throw new OspError(ErrorCodes.InvalidParams, `Ref does not belong to mission ${cleanMission}`);
      }
      targetRef = s;
      const sub = s.slice(expectedPrefix.length);
      if (sub.startsWith("s-")) {
        const numPart = sub.slice(2);
        if (/^\d+$/.test(numPart)) {
          targetSeqNumber = parseInt(numPart, 10);
        }
      }
    } else if (/^[0-9a-f]{40,64}$/i.test(s)) {
      targetRef = s;
    } else {
      throw new OspError(ErrorCodes.InvalidParams, `Invalid snapshot identifier: ${s}`);
    }
  }

  // Resolve target tree
  const treeRes = await runCommandOperation({
    command: `git rev-parse --verify "${targetRef}^{tree}"`,
    cwd: workspaceRoot,
    workspaceRoot,
    env: cleanGitEnv(),
  });
  if (treeRes.exitCode !== 0) {
    throw new OspError(ErrorCodes.InvalidParams, `Snapshot ref not found: ${targetRef}`);
  }
  const targetTree = treeRes.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!targetTree || !/^[0-9a-f]{40,64}$/.test(targetTree)) {
    throw new OspError(ErrorCodes.InvalidParams, `Invalid target tree for snapshot ${targetRef}`);
  }

  // Run Phase 1 tree safety validation (read-only)
  const safety = await validateTreeSafety(workspaceRoot, targetTree);
  if (!safety.valid) {
    throw new OspError(safety.errorCode ?? ErrorCodes.InvalidParams, safety.reason ?? "Tree safety validation failed");
  }

  // Collect overwritten files by checking existing disk content against target blobs
  const overwrittenFiles: string[] = [];
  const targetLsRes = await runCommandOperation({
    command: `git ls-tree -r -z "${targetTree}"`,
    cwd: workspaceRoot,
    workspaceRoot,
    env: cleanGitEnv(),
  });
  if (targetLsRes.exitCode === 0) {
    const entries = targetLsRes.stdout.split("\0").filter((e) => e.length > 0);
    for (const entry of entries) {
      const tabIdx = entry.indexOf("\t");
      if (tabIdx === -1) continue;
      const meta = entry.slice(0, tabIdx);
      const relPath = entry.slice(tabIdx + 1);
      const [mode, type, sha] = meta.split(" ");
      if (mode === "160000") continue; // skip submodules

      const fullPath = path.join(workspaceRoot, relPath);
      try {
        if (fs.existsSync(fullPath)) {
          const diskData = fs.readFileSync(fullPath);
          const header = Buffer.from(`blob ${diskData.length}\0`);
          const diskSha = createHash("sha1").update(header).update(diskData).digest("hex");
          if (diskSha !== sha) {
            overwrittenFiles.push(relPath);
          }
        }
      } catch {}
    }
  }

  return {
    targetRef,
    targetSeqNumber,
    targetTree,
    safety,
    overwrittenFiles,
  };
}

/**
 * Read-only preview of workspace file changes that a restoreSnapshot would perform.
 * Does not write any refs, does not modify index or files.
 */
export async function previewRestore(
  workspaceRoot: string,
  missionId: string,
  snapshotRefOrSeq: string | number
): Promise<RestorePreviewResult> {
  const resolved = await resolveAndValidateRestoreTarget(workspaceRoot, missionId, snapshotRefOrSeq);
  const cleanMission = sanitizeRefName(missionId);

  // Current workspace tree for computeFilesToDelete without creating a ref:
  // treeOf builds it with a temporary GIT_INDEX_FILE + git add -A + git write-tree
  const currentTreeRes = await treeOf(workspaceRoot);
  const currentTree = currentTreeRes.available ? currentTreeRes.tree : undefined;

  const filesToDelete = await computeFilesToDelete(
    workspaceRoot,
    cleanMission,
    resolved.targetTree,
    resolved.targetSeqNumber,
    currentTree
  );

  return {
    targetRef: resolved.targetRef,
    targetTree: resolved.targetTree,
    overwrittenFiles: resolved.overwrittenFiles,
    restoredFiles: resolved.safety.paths,
    deletedFiles: filesToDelete,
    skippedSubmodules: resolved.safety.submodules,
  };
}

/**
 * Restores workspace files to match a step snapshot without modifying HEAD, index, branch, or stash.
 */
export async function restoreSnapshot(
  workspaceRoot: string,
  missionId: string,
  snapshotRefOrSeq: string | number,
  options?: RestoreOptions
): Promise<RestoreExecutionSummary> {
  const resolved = await resolveAndValidateRestoreTarget(workspaceRoot, missionId, snapshotRefOrSeq);
  const cleanMission = sanitizeRefName(missionId);

  // Phase 2: Capture pre-restore safety snapshot
  let preRestoreSnap: StepSnapshotResult | null = null;
  if (!options?.skipPreRestoreSnapshot) {
    const preRestoreSeq = `pre-restore-${Date.now()}`;
    preRestoreSnap = await createStepSnapshot(workspaceRoot, missionId, preRestoreSeq);
    if (!preRestoreSnap) {
      throw new OspError(ErrorCodes.InternalError, "Failed to capture pre-restore snapshot; aborting restore");
    }
  }

  // Phase 3: Compute files to delete safely
  const filesToDelete = await computeFilesToDelete(
    workspaceRoot,
    cleanMission,
    resolved.targetTree,
    resolved.targetSeqNumber,
    preRestoreSnap?.tree
  );

  // Phase 4: Materialize files using temporary index
  const tmpIndex = path.join(os.tmpdir(), `opensand-restore-idx-${randomUUID()}`);
  try {
    if (options?._simulateFailure === "checkout") {
      throw new Error("Simulated mid-restore failure: checkout");
    }
    // 4a. Read tree into isolated index
    const readRes = await runCommandOperation({
      command: `git read-tree "${resolved.targetTree}"`,
      cwd: workspaceRoot,
      workspaceRoot,
      env: { ...cleanGitEnv(), GIT_INDEX_FILE: tmpIndex },
    });
    if (readRes.exitCode !== 0) {
      throw new Error(`git read-tree failed: ${readRes.stderr.trim()}`);
    }

    // 4b. Skip submodules per C5: remove from temp index
    for (const sub of resolved.safety.submodules) {
      await runCommandOperation({
        command: `git update-index --force-remove -- "${sub}"`,
        cwd: workspaceRoot,
        workspaceRoot,
        env: { ...cleanGitEnv(), GIT_INDEX_FILE: tmpIndex },
      });
    }

    // 4c. Checkout files into workspace
    const checkoutRes = await runCommandOperation({
      command: `git checkout-index --all --force`,
      cwd: workspaceRoot,
      workspaceRoot,
      env: { ...cleanGitEnv(), GIT_INDEX_FILE: tmpIndex },
    });
    if (checkoutRes.exitCode !== 0) {
      throw new Error(`git checkout-index failed: ${checkoutRes.stderr.trim()}`);
    }

    // 4d. Unlink eligible deleted files
    for (const relPath of filesToDelete) {
      const fullPath = path.join(workspaceRoot, relPath);
      try {
        const stat = fs.lstatSync(fullPath);
        // C3: never delete a symlink in the workspace
        if (!stat.isSymbolicLink()) {
          fs.unlinkSync(fullPath);
          pruneEmptyParentDirs(workspaceRoot, path.dirname(fullPath));
        }
      } catch (err: any) {
        if (err.code !== "ENOENT") {
          console.warn(`Failed to unlink deleted file ${relPath}:`, err);
        }
      }
    }

    return {
      restoredSnapshot: resolved.targetRef,
      preRestoreSnapshot: preRestoreSnap?.ref ?? "",
      targetTree: resolved.targetTree,
      restoredFilesCount: resolved.safety.paths.length,
      deletedFilesCount: filesToDelete.length,
      restoredFiles: resolved.safety.paths,
      overwrittenFiles: resolved.overwrittenFiles,
      deletedFiles: filesToDelete,
      skippedSubmodules: resolved.safety.submodules,
    };
  } catch (err: any) {
    console.error(`Restore error, executing emergency rollback:`, err);
    try {
      if (preRestoreSnap) {
        const rollbackIndex = path.join(os.tmpdir(), `opensand-rollback-idx-${randomUUID()}`);
        await runCommandOperation({
          command: `git read-tree "${preRestoreSnap.tree}" && git checkout-index --all --force`,
          cwd: workspaceRoot,
          workspaceRoot,
          env: { ...cleanGitEnv(), GIT_INDEX_FILE: rollbackIndex },
        });
        if (fs.existsSync(rollbackIndex)) fs.unlinkSync(rollbackIndex);
      }
    } catch (rbErr) {
      console.error(`Automatic rollback failed:`, rbErr);
    }
    const manualRecoveryCommand = preRestoreSnap
      ? `REC_IDX=$(mktemp -t opensand-rec-XXXXXX) && GIT_INDEX_FILE="$REC_IDX" git --work-tree="${workspaceRoot}" read-tree "${preRestoreSnap.tree}" && GIT_INDEX_FILE="$REC_IDX" git --work-tree="${workspaceRoot}" checkout-index --all --force && rm -f "$REC_IDX"`
      : "";
    throw new OspError(
      ErrorCodes.InternalError,
      `Restore failed midway: ${err.message}. Pre-restore safety snapshot pinned at ${preRestoreSnap?.ref ?? "none"}`,
      {
        preRestoreSnapshot: preRestoreSnap?.ref,
        manualRecoveryCommand,
      }
    );
  } finally {
    try {
      if (fs.existsSync(tmpIndex)) fs.unlinkSync(tmpIndex);
    } catch {}
  }
}
