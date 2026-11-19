import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  AttemptWorktrees,
  type AttemptStep,
} from "../src/attempt-worktrees.js";
import {
  writeLease,
  staleLease,
  leasePath,
} from "../src/attempt-lease.js";

const execGit = promisify(execFile);

describe("attempt worktrees (S2 lifecycle + reconcile)", () => {
  /** Fresh git repo + state dir per test: no leftovers leak between cases. */
  async function setup() {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "s2-repo-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "s2-state-"));
    const missionId = "m-test";
    const attemptsRoot = path.join(stateDir, "missions", missionId, "attempts");
    const logPath = path.join(stateDir, "missions", missionId, "log.jsonl");
    const git = async (args: string[], cwd: string = repoRoot): Promise<string> => {
      const { stdout } = await execGit("git", args, { cwd });
      return stdout;
    };
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "test@opensand.local"]);
    await git(["config", "user.name", "OpenSand Test"]);
    await fs.writeFile(path.join(repoRoot, "README.md"), "base\n");
    await git(["add", "-A"]);
    await git(["commit", "-m", "base"]);
    const baseCommit = (await git(["rev-parse", "HEAD"])).trim();
    await fs.mkdir(attemptsRoot, { recursive: true });
    const opts = (hooks?: { failAt?: (step: AttemptStep) => boolean }) => ({
      repoRoot,
      attemptsRoot,
      missionId,
      baseCommit,
      logPath,
      hooks,
    });
    const cleanup = async () => {
      await fs.rm(repoRoot, { recursive: true, force: true });
      await fs.rm(stateDir, { recursive: true, force: true });
    };
    return { repoRoot, stateDir, missionId, attemptsRoot, logPath, baseCommit, git, opts, cleanup };
  }

  function snapshotRef(missionId: string, n: number): string {
    return `refs/opensand/missions/${missionId}/attempts/${n}`;
  }

  async function worktreePaths(git: (args: string[], cwd?: string) => Promise<string>): Promise<string[]> {
    const out = await git(["worktree", "list", "--porcelain"]);
    return out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
  }

  it("full loser lifecycle ends with only the main worktree, empty root, and a snapshot ref", { timeout: 30_000 }, async () => {
    const s = await setup();
    try {
      const m = new AttemptWorktrees(s.opts());
      await m.reserve(1);
      await m.create(1);
      await m.markRunning(1);
      await dirtyTree(s.attemptsRoot, 1);
      await m.markChecked(1, 1);
      await m.finish(1, "check_failed");
      await m.snapshot(1);
      await m.remove(1);

      const wts = await worktreePaths(s.git);
      assert.equal(wts.length, 1, `expected only main, got ${wts.join(", ")}`);
      assert.equal((await fs.readdir(s.attemptsRoot)).length, 0);
      const ref = snapshotRef(s.missionId, 1);
      const notes = await s.git(["cat-file", "-p", `${ref}:notes.txt`]);
      assert.match(notes, /untracked work/);
      const log = await fs.readFile(s.logPath, "utf8");
      assert.match(log, /"kind":"attempt\.removed"/);
    } finally {
      await s.cleanup();
    }
  });

  it("winner lifecycle keeps the worktree and branches at its tree", { timeout: 30_000 }, async () => {
    const s = await setup();
    try {
      const m = new AttemptWorktrees(s.opts());
      await m.reserve(2);
      await m.create(2);
      await m.markRunning(2);
      await dirtyTree(s.attemptsRoot, 2);
      await m.markChecked(2, 0);
      await m.finish(2, "passed");
      await m.keep(2);

      const wts = await worktreePaths(s.git);
      assert.equal(wts.length, 2, `expected main + kept, got ${wts.join(", ")}`);
      const branch = `opensand/${s.missionId}/2`;
      const notes = await s.git(["cat-file", "-p", `${branch}:notes.txt`]);
      assert.match(notes, /untracked work/);
      // lease removed at keep
      await assert.rejects(fs.access(leasePath(s.attemptsRoot, 2)));
      // worktree still present
      await fs.access(path.join(s.attemptsRoot, "2"));
    } finally {
      await s.cleanup();
    }
  });

  it("two attempts editing the same file each see only their own edit", { timeout: 30_000 }, async () => {
    const s = await setup();
    try {
      const m = new AttemptWorktrees(s.opts());
      for (const n of [3, 4]) {
        await m.reserve(n);
        await m.create(n);
        await m.markRunning(n);
      }
      await fs.writeFile(path.join(s.attemptsRoot, "3", "README.md"), "attempt three\n");
      await fs.writeFile(path.join(s.attemptsRoot, "4", "README.md"), "attempt four\n");
      await m.markChecked(3, 0);
      await m.finish(3, "passed");
      await m.keep(3);

      const readThree = await fs.readFile(path.join(s.attemptsRoot, "3", "README.md"), "utf8");
      const readFour = await fs.readFile(path.join(s.attemptsRoot, "4", "README.md"), "utf8");
      assert.equal(readThree, "attempt three\n");
      assert.equal(readFour, "attempt four\n");
      const branch = await s.git(["cat-file", "-p", `opensand/${s.missionId}/3:README.md`]);
      assert.equal(branch, "attempt three\n");
    } finally {
      await s.cleanup();
    }
  });

  // Crash at each of the 7 lifecycle steps (after the step's record is written,
  // before its action — the window log-before-action exists for), then reconcile.
  // Steps after create have a dirty tree, so the snapshot ref must hold the
  // untracked file; reserve/create never got a tree to dirty.
  for (const step of ["reserve", "create", "run", "check", "finish", "snapshot", "remove"] as const) {
    it(`crash at ${step} then reconcile leaves only main, empty root, snapshot ref holds dirty file`, { timeout: 30_000 }, async () => {
      const s = await setup();
      try {
        const stepIdx = ["reserve", "create", "run", "check", "finish", "snapshot", "remove"].indexOf(step);
        const n = 10 + stepIdx;
        const m = new AttemptWorktrees(s.opts({ failAt: (x) => x === step }));
        await assert.rejects(async () => {
          await m.reserve(n);
          await m.create(n);
          await dirtyTree(s.attemptsRoot, n);
          await m.markRunning(n);
          await m.markChecked(n, 1);
          await m.finish(n, "check_failed");
          await m.snapshot(n);
          await m.remove(n);
        });
        // The owner died: its lease must read as stale.
        await staleLease(s.attemptsRoot, n);

        const r = new AttemptWorktrees(s.opts());
        await r.reconcile();

        const wts = await worktreePaths(s.git);
        assert.equal(wts.length, 1, `expected only main after reconcile, got ${wts.join(", ")}`);
        const leftover = await fs.readdir(s.attemptsRoot);
        assert.deepEqual(leftover, [], `attempts root not empty: ${leftover.join(", ")}`);
        if (stepIdx >= 2) {
          const ref = snapshotRef(s.missionId, n);
          const notes = await s.git(["cat-file", "-p", `${ref}:notes.txt`]);
          assert.match(notes, /untracked work/);
        }

        // Idempotent: a second reconcile changes nothing.
        const before = await worktreePaths(s.git);
        await r.reconcile();
        assert.deepEqual(await worktreePaths(s.git), before);
        assert.deepEqual(await fs.readdir(s.attemptsRoot), []);
      } finally {
        await s.cleanup();
      }
    });
  }

  it("crash at keep then reconcile completes the keep", { timeout: 30_000 }, async () => {
    const s = await setup();
    try {
      const n = 30;
      const m = new AttemptWorktrees(s.opts({ failAt: (x) => x === "keep" }));
      await assert.rejects(async () => {
        await m.reserve(n);
        await m.create(n);
        await dirtyTree(s.attemptsRoot, n);
        await m.markRunning(n);
        await m.markChecked(n, 0);
        await m.finish(n, "passed");
        await m.keep(n);
      });
      await staleLease(s.attemptsRoot, n);

      const r = new AttemptWorktrees(s.opts());
      await r.reconcile();

      const wts = await worktreePaths(s.git);
      assert.equal(wts.length, 2, `expected main + kept, got ${wts.join(", ")}`);
      assert.ok((await s.git(["rev-parse", "--verify", `opensand/${s.missionId}/${n}`])).trim().length === 40);
      await assert.rejects(fs.access(leasePath(s.attemptsRoot, n)));
    } finally {
      await s.cleanup();
    }
  });

  it("a live lease makes reconcile skip the attempt", { timeout: 30_000 }, async () => {
    const s = await setup();
    try {
      const n = 40;
      const m = new AttemptWorktrees(s.opts());
      await m.reserve(n);
      await m.create(n);
      await m.markRunning(n);
      await dirtyTree(s.attemptsRoot, n);
      // Lease written by this (live) process stays live.
      await writeLease(s.attemptsRoot, n);

      const r = new AttemptWorktrees(s.opts());
      const report = await r.reconcile();
      assert.ok(
        report.some((e) => e.attempt === n && e.action === "skipped-live"),
        `expected skipped-live, got ${JSON.stringify(report)}`,
      );
      // The attempt's directory survives and the worktree is still registered.
      await fs.access(path.join(s.attemptsRoot, String(n)));
      const wts = await worktreePaths(s.git);
      assert.equal(wts.length, 2);

      // The owner dies: reconcile now finishes the attempt.
      await staleLease(s.attemptsRoot, n);
      await r.reconcile();
      const wts2 = await worktreePaths(s.git);
      assert.equal(wts2.length, 1);
      assert.deepEqual(await fs.readdir(s.attemptsRoot), []);
    } finally {
      await s.cleanup();
    }
  });

  it("orphan scan removes unregistered directories and unreserved worktrees, never paths outside the root", { timeout: 30_000 }, async () => {
    const s = await setup();
    try {
      // 1. A plain directory under the root with no worktree registration.
      await fs.mkdir(path.join(s.attemptsRoot, "99"), { recursive: true });
      await fs.writeFile(path.join(s.attemptsRoot, "99", "junk.txt"), "x");
      // 2. A registered worktree under the root whose attempt.reserved record is missing.
      const orphanPath = path.join(s.attemptsRoot, "98");
      await s.git(["worktree", "add", "--detach", orphanPath, s.baseCommit]);
      await fs.writeFile(path.join(orphanPath, "orphan.txt"), "orphan work\n");
      // 3. A registered worktree OUTSIDE the root: reconcile must never touch it.
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "s2-outside-"));
      const outsideWt = path.join(outsideDir, "wt");
      await s.git(["worktree", "add", "--detach", outsideWt, s.baseCommit]);

      const r = new AttemptWorktrees(s.opts());
      await r.reconcile();

      await assert.rejects(fs.access(path.join(s.attemptsRoot, "99")));
      await assert.rejects(fs.access(orphanPath));
      const wts = await worktreePaths(s.git);
      const outsideReal = await fs.realpath(outsideWt);
      assert.equal(wts.length, 2, `expected main + outside worktree, got ${wts.join(", ")}`);
      assert.ok(wts.some((w) => w === outsideReal));
      // Snapshot of the dirty orphan holds its untracked file.
      const ref = snapshotRef(s.missionId, 98);
      const orphan = await s.git(["cat-file", "-p", `${ref}:orphan.txt`]);
      assert.match(orphan, /orphan work/);
      // Idempotent.
      await r.reconcile();
      assert.equal((await worktreePaths(s.git)).length, 2);

      await s.git(["worktree", "remove", "--force", outsideWt]);
      await fs.rm(outsideDir, { recursive: true, force: true });
    } finally {
      await s.cleanup();
    }
  });

  it("a second finish for the same attempt is refused", { timeout: 30_000 }, async () => {
    const s = await setup();
    try {
      const n = 50;
      const m = new AttemptWorktrees(s.opts());
      await m.reserve(n);
      await m.create(n);
      await m.finish(n, "check_failed");
      await assert.rejects(() => m.finish(n, "passed"));
      await m.snapshot(n);
      await m.remove(n);
    } finally {
      await s.cleanup();
    }
  });

  it("remove refuses a path outside the attempts root", { timeout: 30_000 }, async () => {
    const s = await setup();
    try {
      const m = new AttemptWorktrees(s.opts());
      await assert.rejects(() => m.removePath(s.repoRoot, { force: true }));
    } finally {
      await s.cleanup();
    }
  });
});

async function dirtyTree(attemptsRoot: string, n: number): Promise<void> {
  const wt = path.join(attemptsRoot, String(n));
  await fs.appendFile(path.join(wt, "README.md"), "attempt edit\n");
  await fs.writeFile(path.join(wt, "notes.txt"), "untracked work\n");
}
