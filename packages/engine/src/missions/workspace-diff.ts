function cleanGitEnv(): Record<string, string> {
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
import { randomUUID } from "node:crypto";
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
