import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventLogLock } from "@opensand/shared";
import {
  readLease,
  removeLease,
  isLeaseLive,
  writeLease,
  staleLease,
} from "./attempt-lease.js";

const execAsync = promisify(execFile);

export type AttemptStep =
  | "reserve"
  | "create"
  | "run"
  | "check"
  | "finish"
  | "snapshot"
  | "remove"
  | "keep";

export type AttemptOutcome =
  | "passed"
  | "check_failed"
  | "no_change"
  | "review_rejected"
  | "timeout"
  | "infra_error"
  | "interrupted"
  | "budget_stopped";

export interface AttemptLogRecord {
  ts: string;
  kind: string;
  n: number;
  [key: string]: unknown;
}

export interface AttemptWorktreesOptions {
  /** The target repository the attempts branch from. */
  repoRoot: string;
  /** Where attempt worktrees live: <stateDir>/missions/<missionId>/attempts. */
  attemptsRoot: string;
  missionId: string;
  /** Base commit B the attempt starts from (the repo HEAD when the tournament started). */
  baseCommit: string;
  /** Append-only JSONL record log; defaults to <attemptsRoot>/../log.jsonl. */
  logPath?: string;
  /** Fault injection: failAt(step) returning true makes the next step throw (simulated crash). */
  hooks?: { failAt?: (step: AttemptStep) => boolean };
}

export interface ReconcileEntry {
  attempt: number;
  action: string;
}

function attemptRef(missionId: string, n: number): string {
  return `refs/opensand/missions/${missionId}/attempts/${n}`;
}

export class AttemptWorktrees {
  private readonly repoRoot: string;
  private readonly attemptsRoot: string;
  private readonly missionId: string;
  private readonly baseCommit: string;
  private readonly logPath: string;
  private readonly hooks?: AttemptWorktreesOptions["hooks"];

  constructor(options: AttemptWorktreesOptions) {
    this.repoRoot = options.repoRoot;
    this.attemptsRoot = options.attemptsRoot;
    this.missionId = options.missionId;
    this.baseCommit = options.baseCommit;
    this.logPath = options.logPath ?? path.join(path.dirname(options.attemptsRoot), "log.jsonl");
    this.hooks = options.hooks;
  }

  attemptPath(n: number): string {
    return path.join(this.attemptsRoot, String(n));
  }

  private failAt(step: AttemptStep): void {
    if (this.hooks?.failAt?.(step)) {
      throw new Error(`simulated crash at step: ${step}`);
    }
  }

  /**
   * Strip GIT_* environment variables so operations on one repository cannot
   * be redirected into another (same defense as coordinator GitManager).
   */
  private gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith("GIT_")) delete env[k];
    }
    return { ...env, ...extra } as NodeJS.ProcessEnv;
  }

  private async git(args: string[], cwd?: string, extraEnv?: Record<string, string>): Promise<string> {
    const { stdout } = await execAsync(
      "git",
      ["--no-pager", ...args],
      { cwd: cwd ?? this.repoRoot, env: this.gitEnv(extraEnv), windowsHide: true },
    );
    return stdout;
  }

  private async withWorktreeLock<T>(fn: () => Promise<T>): Promise<T> {
    const commonDir = (await this.git(["rev-parse", "--git-common-dir"])).trim();
    const lock = await EventLogLock.acquire(path.resolve(this.repoRoot, commonDir), {
      lockFileName: "opensand-worktrees.lock",
      timeoutMs: 120_000,
    });
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  // ---- record log ----

  private async appendLog(kind: string, n: number, data: Record<string, unknown> = {}): Promise<void> {
    const record: AttemptLogRecord = { ts: new Date().toISOString(), kind, n, ...data };
    await fs.appendFile(this.logPath, JSON.stringify(record) + "\n", "utf8");
  }

  private async readLog(): Promise<AttemptLogRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.logPath, "utf8");
    } catch {
      return [];
    }
    const records: AttemptLogRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AttemptLogRecord;
        if (typeof parsed?.kind === "string" && typeof parsed?.n === "number") records.push(parsed);
      } catch {
        // Trailing fragment from a crash; ignore the partial line.
      }
    }
    return records;
  }

  private async lastRecordFor(n: number): Promise<AttemptLogRecord | null> {
    const records = await this.readLog();
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].n === n) return records[i];
    }
    return null;
  }

  // ---- lifecycle steps (log record always before the filesystem action) ----

  /**
   * failAt throws after the record is written but before the action it
   * describes: that log-before-action window is exactly what reconcile exists
   * to repair, so it is the crash the fault injection simulates.
   */
  async reserve(n: number): Promise<void> {
    await fs.mkdir(this.attemptsRoot, { recursive: true });
    await this.appendLog("attempt.reserved", n, { path: this.attemptPath(n) });
    this.failAt("reserve");
    await writeLease(this.attemptsRoot, n);
  }

  async create(n: number): Promise<void> {
    await fs.mkdir(this.attemptsRoot, { recursive: true });
    await this.appendLog("attempt.created", n);
    this.failAt("create");
    const wt = this.attemptPath(n);
    await this.withWorktreeLock(async () => {
      if (await this.isWorktreeAt(wt, this.baseCommit)) return;
      if (await this.isRegistered(wt)) {
        // Registered at the wrong commit: remove and recreate.
        await this.git(["worktree", "remove", "--force", wt]);
      }
      await fs.rm(wt, { recursive: true, force: true });
      await this.git(["worktree", "add", "--detach", wt, this.baseCommit]);
    });
  }

  async markRunning(n: number): Promise<void> {
    await this.appendLog("attempt.running", n);
    this.failAt("run");
  }

  async markChecked(n: number, exit: number): Promise<void> {
    await this.appendLog("attempt.checked", n, { exit });
    this.failAt("check");
  }

  async finish(n: number, outcome: AttemptOutcome): Promise<void> {
    const last = await this.lastRecordFor(n);
    if (last?.kind === "attempt.finished") {
      throw new Error(`attempt ${n} already finished (${String(last.outcome)})`);
    }
    await this.appendLog("attempt.finished", n, { outcome });
    this.failAt("finish");
  }

  /**
   * Commit the attempt tree to its ref with a temporary index, leaving the
   * worktree's own index and HEAD untouched. Untracked files are included.
   */
  async snapshot(n: number): Promise<string> {
    this.failAt("snapshot");
    const ref = attemptRef(this.missionId, n);
    const wt = this.attemptPath(n);
    const tree = await this.treeOf(wt);
    const existing = await this.refTree(ref);
    if (existing === tree) return ref; // idempotent: already at the expected tree
    await this.appendLog("attempt.snapshotted", n, { ref });
    this.failAt("snapshot");
    const head = (await this.git(["rev-parse", "HEAD"], wt)).trim();
    const commit = await this.commitTree(wt, tree, head, `opensand snapshot attempt ${n}`);
    await this.git(["update-ref", ref, commit]);
    return ref;
  }

  async remove(n: number): Promise<void> {
    this.failAt("remove");
    const last = await this.lastRecordFor(n);
    if (last?.kind === "attempt.removed") return; // re-run until removed is logged; then no-op
    await this.appendLog("attempt.removing", n);
    this.failAt("remove");
    const wt = this.attemptPath(n);
    const snapshotted = Boolean(await this.refTree(attemptRef(this.missionId, n)));
    // --force only once the tree is committed to a ref (or nothing is dirty).
    await this.removePath(wt, { force: snapshotted || !(await this.isDirty(wt)) });
    await this.appendLog("attempt.removed", n);
    await removeLease(this.attemptsRoot, n);
  }

  /** Remove a worktree path, refusing anything outside the attempts root (checked after realpath). */
  async removePath(target: string, opts: { force: boolean }): Promise<void> {
    const root = await this.realPath(this.attemptsRoot);
    const resolved = await this.realPath(target);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`refusing to remove path outside the attempts root: ${resolved}`);
    }
    try {
      await this.withWorktreeLock(async () => {
        await this.git(["worktree", "remove", ...(opts.force ? ["--force"] : []), resolved]);
      });
    } catch (err) {
      if (fsSync.existsSync(resolved)) {
        throw err; // dirty tree without a snapshot: never delete work
      }
      // Directory already gone while the registration remains: deregister
      // that one named path (never a global `git worktree prune`).
      await this.deregisterMissingWorktree(resolved);
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }

  async keep(n: number): Promise<void> {
    this.failAt("keep");
    const wt = this.attemptPath(n);
    const branch = `opensand/${this.missionId}/${n}`;
    let commit: string;
    if (await this.isDirty(wt)) {
      commit = await this.commitTree(
        wt,
        await this.treeOf(wt),
        (await this.git(["rev-parse", "HEAD"], wt)).trim(),
        `opensand keep attempt ${n}`,
      );
    } else {
      commit = (await this.git(["rev-parse", "HEAD"], wt)).trim();
    }
    const existing = await this.refTree(branch);
    if (existing !== null) {
      const wanted = (await this.git(["rev-parse", `${commit}^{tree}`])).trim();
      if (existing !== wanted) {
        throw new Error(`branch ${branch} exists at a different tree`);
      }
      return; // branch exists at the same commit: skip
    }
    await this.appendLog("attempt.kept", n, { branch, commit });
    this.failAt("keep");
    await this.git(["branch", branch, commit]);
    await removeLease(this.attemptsRoot, n);
  }

  // ---- reconcile (§4.3) ----

  /**
   * Resume or clean up every non-terminal attempt, then scan for orphans.
   * Idempotent: a second run changes nothing.
   */
  async reconcile(): Promise<ReconcileEntry[]> {
    const report: ReconcileEntry[] = [];
    const records = await this.readLog();
    const attempts = [...new Set(records.map((r) => r.n))].sort((a, b) => a - b);
    for (const n of attempts) {
      const entry = await this.reconcileAttempt(n);
      if (entry) report.push(entry);
    }
    report.push(...(await this.orphanScan()));
    return report;
  }

  private async reconcileAttempt(n: number): Promise<ReconcileEntry | null> {
    const last = await this.lastRecordFor(n);
    if (!last) return null;
    if (last.kind === "attempt.removed" || last.kind === "attempt.kept") return null; // terminal

    // A live lease means another engine owns this attempt right now.
    const lease = await readLease(this.attemptsRoot, n);
    if (lease && (await isLeaseLive(lease))) {
      return { attempt: n, action: "skipped-live" };
    }

    const wt = this.attemptPath(n);
    const registered = await this.isRegistered(wt);

    switch (last.kind) {
      case "attempt.reserved": {
        if (!registered) {
          // Reserved but never created: nothing to snapshot or remove.
          await this.finishInterrupted(n);
          await this.appendLog("attempt.removing", n);
          await fs.rm(wt, { recursive: true, force: true });
          await this.appendLog("attempt.removed", n);
          await removeLease(this.attemptsRoot, n);
        } else {
          await this.snapshotThenRemove(n);
        }
        return { attempt: n, action: "resumed" };
      }
      case "attempt.created":
      case "attempt.running":
      case "attempt.checked": {
        await this.snapshotThenRemove(n);
        return { attempt: n, action: "resumed" };
      }
      case "attempt.finished": {
        if (last.outcome === "passed" && registered) {
          await this.keep(n);
        } else {
          await this.snapshotThenRemove(n);
        }
        return { attempt: n, action: "resumed" };
      }
      case "attempt.snapshotted":
      case "attempt.removing": {
        await this.snapshotThenRemove(n);
        return { attempt: n, action: "resumed" };
      }
      case "attempt.kept": {
        // Kept was logged but the branch action never ran.
        const branch = `opensand/${this.missionId}/${n}`;
        if ((await this.refTree(branch)) === null) {
          await this.keep(n);
          return { attempt: n, action: "resumed" };
        }
        await removeLease(this.attemptsRoot, n);
        return null;
      }
      default:
        return null;
    }
  }

  private async finishInterrupted(n: number): Promise<void> {
    await this.appendLog("attempt.finished", n, { outcome: "interrupted" });
  }

  /** Snapshot an unsnapshotted non-terminal attempt, then remove its worktree. */
  private async snapshotThenRemove(n: number): Promise<void> {
    const wt = this.attemptPath(n);
    const registered = await this.isRegistered(wt);
    if (registered) {
      const ref = attemptRef(this.missionId, n);
      const alreadySnapshotted = Boolean(await this.refTree(ref));
      if (!alreadySnapshotted) {
        // Without a snapshot the attempt never finished; it counts as
        // interrupted, and interrupted attempts are snapshotted (§4.1 step 6).
        const last = await this.lastRecordFor(n);
        if (last?.kind !== "attempt.finished") await this.finishInterrupted(n);
        await this.snapshot(n);
      }
      await this.removePath(wt, { force: true });
    }
    await this.appendLog("attempt.removing", n);
    await fs.rm(wt, { recursive: true, force: true });
    await this.appendLog("attempt.removed", n);
    await removeLease(this.attemptsRoot, n);
  }

  /** Worktrees registered under the attempts root, and dirs under it with no registration. */
  private async orphanScan(): Promise<ReconcileEntry[]> {
    const report: ReconcileEntry[] = [];
    const root = await this.realPath(this.attemptsRoot);
    const porcelain = await this.git(["worktree", "list", "--porcelain"]);
    const registeredPaths: string[] = [];
    for (const line of porcelain.split("\n")) {
      if (line.startsWith("worktree ")) registeredPaths.push(line.slice("worktree ".length));
    }
    const resolvedRegistered = new Set<string>();
    for (const p of registeredPaths) resolvedRegistered.add(await this.realPath(p));

    const records = await this.readLog();
    const reservedNs = new Set(
      records.filter((r) => r.kind === "attempt.reserved").map((r) => r.n),
    );

    for (const [i, registered] of registeredPaths.entries()) {
      const resolved = [...resolvedRegistered][i];
      if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;
      const base = path.basename(resolved);
      if (!/^\d+$/.test(base)) continue;
      const n = Number(base);
      if (reservedNs.has(n)) continue; // normal reconcile owns this one
      // Orphan: no reserved record. Snapshot if dirty, then remove.
      if (await this.isDirty(resolved)) {
        await this.snapshot(n);
      }
      await this.removePath(resolved, { force: true });
      report.push({ attempt: n, action: "orphan-removed" });
    }

    // Directories under the root with no worktree registration are deleted.
    let entries: string[] = [];
    try {
      entries = await fs.readdir(root);
    } catch {
      return report;
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const full = path.join(root, entry);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat?.isDirectory()) continue;
      if (resolvedRegistered.has(await this.realPath(full))) continue;
      await fs.rm(full, { recursive: true, force: true });
      report.push({ attempt: Number(entry), action: "orphan-dir-deleted" });
    }
    return report;
  }

  // ---- git helpers ----

  private async realPath(p: string): Promise<string> {
    try {
      return await fs.realpath(p);
    } catch {
      return path.resolve(p);
    }
  }

  private async isRegistered(wt: string): Promise<boolean> {
    const porcelain = await this.git(["worktree", "list", "--porcelain"]);
    const resolved = await this.realPath(wt);
    for (const line of porcelain.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const p = await this.realPath(line.slice("worktree ".length));
      if (p === resolved) return true;
    }
    return false;
  }

  private async isWorktreeAt(wt: string, commit: string): Promise<boolean> {
    if (!(await this.isRegistered(wt))) return false;
    try {
      return (await this.git(["rev-parse", "HEAD"], wt)).trim() === commit;
    } catch {
      return false;
    }
  }

  private async isDirty(wt: string): Promise<boolean> {
    try {
      const status = await this.git(["status", "--porcelain"], wt);
      return status.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Current tree of a worktree, computed with a temporary index. */
  private async treeOf(wt: string): Promise<string> {
    const tmpIndex = path.join(os.tmpdir(), `opensand-attempt-idx-${crypto.randomUUID()}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      await this.git(["add", "-A", "--"], wt, env);
      return (await this.git(["write-tree"], wt, env)).trim();
    } finally {
      await fs.rm(tmpIndex, { force: true });
    }
  }

  /** Commit an already-computed tree with a synthetic identity (commit-tree touches no index or HEAD). */
  private async commitTree(wt: string, tree: string, parent: string, message: string): Promise<string> {
    const env = {
      GIT_AUTHOR_NAME: "opensand",
      GIT_AUTHOR_EMAIL: "opensand@localhost",
      GIT_COMMITTER_NAME: "opensand",
      GIT_COMMITTER_EMAIL: "opensand@localhost",
    };
    return (await this.git(["commit-tree", tree, "-p", parent, "-m", message], wt, env)).trim();
  }

  private async refTree(ref: string): Promise<string | null> {
    try {
      return (await this.git(["rev-parse", `${ref}^{tree}`])).trim();
    } catch {
      return null;
    }
  }

  /**
   * Deregister a single worktree whose directory is already gone, by removing
   * its .git/worktrees/<name> entry. Never a global `git worktree prune`
   * (git-manager.ts: the prune-vs-concurrent-add race).
   */
  private async deregisterMissingWorktree(resolved: string): Promise<void> {
    let commonDir: string;
    try {
      commonDir = (await this.git(["rev-parse", "--git-common-dir"])).trim();
    } catch {
      return;
    }
    const worktreesDir = path.resolve(this.repoRoot, commonDir, "worktrees");
    let names: string[] = [];
    try {
      names = await fs.readdir(worktreesDir);
    } catch {
      return;
    }
    for (const name of names) {
      const gitdirFile = path.join(worktreesDir, name, "gitdir");
      const content = await fs.readFile(gitdirFile, "utf8").catch(() => "");
      const registered = content.trim().replace(/\/\.git$/, "");
      if (registered && (await this.realPath(registered)) === resolved) {
        await fs.rm(path.join(worktreesDir, name), { recursive: true, force: true });
      }
    }
  }
}
