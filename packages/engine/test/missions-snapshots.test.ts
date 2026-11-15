import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { EventLogReader, type SessionEvent } from "@opensand/shared";
import { EngineProcess, removeDir, tempDir, trustFolder, cleanGitEnv } from "./helpers.js";
import { createStepSnapshot, treeOf } from "../src/missions/workspace-diff.js";

function git(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...cleanGitEnv(), ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function tempWorkspaceDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opensand-workspace-"));
}

function makeWorkspace(root: string, files: Record<string, string>): string {
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  git(["init", "-q"], workspace);
  git(["config", "user.email", "test@example.com"], workspace);
  git(["config", "user.name", "OpenSand Test"], workspace);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  git(["add", "-A"], workspace);
  git(["commit", "-q", "--no-gpg-sign", "-m", "initial"], workspace);
  return workspace;
}

function writeAgent(dir: string, spec: unknown): string {
  const file = path.join(dir, "agent.json");
  fs.writeFileSync(file, JSON.stringify(spec, null, 2), "utf8");
  return file;
}

async function readMissionEvents(stateDir: string, missionId: string): Promise<SessionEvent[]> {
  return new EventLogReader(path.join(stateDir, "missions", missionId)).readAll();
}

async function waitForMissionEnd(
  engine: EngineProcess,
  missionId: string,
  timeoutMs = 30_000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = undefined;
  while (Date.now() < deadline) {
    const response = await engine.request(`poll-${missionId}-${Date.now()}`, "mission.Missions.get", {
      missionId,
    });
    last = response.result;
    if (last && ["verified", "failed", "stopped"].includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`mission ${missionId} did not finish; last status ${JSON.stringify(last)}`);
}

describe("missions snapshots (phase 6)", () => {
  it("(a) A 2-step mission pins refs/opensand/missions/<id>/s-<n> for each step and tree matches workspace", async () => {
    const dir = tempDir("snapshot-2step");
    const workspaceDir = tempWorkspaceDir();
    const workspace = makeWorkspace(workspaceDir, { "file.txt": "initial\n" });

    // Initial tree of the workspace
    const tree0 = git(["rev-parse", "HEAD^{tree}"], workspace).trim();

    // 2-step agent: round 1 writes file.txt = step1, review rejects -> repair -> round 2 writes file.txt = step2, review accepts
    const agent = writeAgent(dir, [
      { writes: { "file.txt": "step1\n" }, review: { accept: false, note: "needs step 2" } },
      { writes: { "file.txt": "step2\n" }, review: { accept: true, note: "good" } },
    ]);
    trustFolder(dir, workspace);
    const engine = new EngineProcess(dir, ["--scripted-agent", agent]);
    try {
      const start = await engine.request("req-1", "mission.Missions.start", {
        workspaceRoot: workspace,
        title: "2-step mission",
        initialQuery: "do steps",
        checkCommand: "true",
      });
      assert.equal(start.error, undefined);
      const missionId = start.result.missionId;
      const final = await waitForMissionEnd(engine, missionId);
      assert.equal(final.status, "verified");

      const events = await readMissionEvents(dir, missionId);
      const startedEvents = events.filter((e) => e.kind === "node.started" && e.data?.snapshot);
      assert.ok(startedEvents.length >= 2, `expected at least 2 snapshot events, got ${startedEvents.length}`);

      // Step 1 act node snapshot
      const s1Event = startedEvents[0];
      assert.equal(s1Event.data.node, "act");
      const ref1 = s1Event.data.snapshot as string;
      assert.match(ref1, new RegExp(`^refs/opensand/missions/${missionId}/s-1$`));
      const tree1FromRef = git(["rev-parse", `${ref1}^{tree}`], workspace).trim();
      assert.equal(tree1FromRef, tree0, "snapshot 1 tree must equal initial workspace tree");

      // Later step snapshot (after step1 writes)
      const s2Event = startedEvents[1];
      const ref2 = s2Event.data.snapshot as string;
      assert.match(ref2, new RegExp(`^refs/opensand/missions/${missionId}/s-\\d+$`));
      const tree2FromRef = git(["rev-parse", `${ref2}^{tree}`], workspace).trim();
      assert.ok(tree2FromRef, "snapshot 2 tree must exist");

      // Verify the content in ref2 matches step 1's write
      const contentInRef2 = git(["cat-file", "-p", `${ref2}:file.txt`], workspace);
      assert.equal(contentInRef2, "step1\n");
    } finally {
      await engine.kill();
      removeDir(dir);
      removeDir(workspaceDir);
    }
  });

  it("(b) The user's git state is untouched", async () => {
    const dir = tempDir("snapshot-git-state");
    const workspaceDir = tempWorkspaceDir();
    const workspace = makeWorkspace(workspaceDir, { "base.txt": "base\n" });

    // Set up user's git state:
    // 1. stash entry
    fs.writeFileSync(path.join(workspace, "stash.txt"), "stashed content\n");
    git(["add", "stash.txt"], workspace);
    git(["stash", "push", "-m", "user-stash"], workspace);

    // 2. staged edit
    fs.writeFileSync(path.join(workspace, "staged.txt"), "staged edit\n");
    git(["add", "staged.txt"], workspace);

    // 3. unstaged edit
    fs.appendFileSync(path.join(workspace, "base.txt"), "unstaged edit\n");

    // 4. untracked file
    fs.writeFileSync(path.join(workspace, "untracked.txt"), "untracked file\n");

    // Record git state before
    const statusBefore = git(["status", "--porcelain"], workspace);
    const diffBefore = git(["diff"], workspace);
    const diffCachedBefore = git(["diff", "--cached"], workspace);
    const headBefore = git(["rev-parse", "HEAD"], workspace);
    const stashBefore = git(["stash", "list"], workspace);

    // Call createStepSnapshot directly
    const snap = await createStepSnapshot(workspace, "test-state-preservation", 1);
    assert.ok(snap);
    assert.ok(snap.ref);

    // Record git state after
    const statusAfter = git(["status", "--porcelain"], workspace);
    const diffAfter = git(["diff"], workspace);
    const diffCachedAfter = git(["diff", "--cached"], workspace);
    const headAfter = git(["rev-parse", "HEAD"], workspace);
    const stashAfter = git(["stash", "list"], workspace);

    assert.equal(statusAfter, statusBefore, "git status --porcelain must be byte-identical");
    assert.equal(diffAfter, diffBefore, "git diff must be byte-identical");
    assert.equal(diffCachedAfter, diffCachedBefore, "git diff --cached must be byte-identical");
    assert.equal(headAfter, headBefore, "git rev-parse HEAD must be byte-identical");
    assert.equal(stashAfter, stashBefore, "git stash list must be byte-identical");

    // Also verify untracked and staged files are captured in the snapshot
    const catStaged = git(["cat-file", "-p", `${snap.ref}:staged.txt`], workspace);
    assert.equal(catStaged, "staged edit\n");
    const catUntracked = git(["cat-file", "-p", `${snap.ref}:untracked.txt`], workspace);
    assert.equal(catUntracked, "untracked file\n");

    removeDir(dir);
    removeDir(workspaceDir);
  });

  it("(c) The refs survive git gc --prune=now", async () => {
    const workspaceDir = tempWorkspaceDir();
    const workspace = makeWorkspace(workspaceDir, { "file.txt": "gc-test\n" });

    const snap = await createStepSnapshot(workspace, "gc-survive-mission", 1);
    assert.ok(snap);
    const ref = snap.ref;

    const treeBefore = git(["rev-parse", `${ref}^{tree}`], workspace).trim();

    // Run git gc --prune=now
    git(["gc", "--prune=now"], workspace);

    // Ref and its tree must still exist
    const treeAfter = git(["rev-parse", `${ref}^{tree}`], workspace).trim();
    assert.equal(treeAfter, treeBefore);
    assert.equal(treeAfter, snap.tree);

    removeDir(workspaceDir);
  });

  it("(d) A non-git workspace: the step runs normally and there is no snapshot field", async () => {
    const dir = tempDir("snapshot-nongit");
    const nonGitWorkspace = tempWorkspaceDir();
    fs.writeFileSync(path.join(nonGitWorkspace, "hello.txt"), "hello non-git\n");

    // Verify createStepSnapshot returns null for non-git
    const directSnap = await createStepSnapshot(nonGitWorkspace, "non-git-mission", 1);
    assert.equal(directSnap, null);

    const agent = writeAgent(dir, [
      { claim: "non-git step done", review: { accept: true, note: "ok" } },
    ]);
    trustFolder(dir, nonGitWorkspace);
    const engine = new EngineProcess(dir, ["--scripted-agent", agent]);
    try {
      const start = await engine.request("req-1", "mission.Missions.start", {
        workspaceRoot: nonGitWorkspace,
        title: "non-git mission",
        initialQuery: "work in non-git",
        checkCommand: "true",
      });
      assert.equal(start.error, undefined);
      const missionId = start.result.missionId;
      const final = await waitForMissionEnd(engine, missionId);
      assert.equal(final.status, "verified");

      const events = await readMissionEvents(dir, missionId);
      const actStarted = events.find((e) => e.kind === "node.started" && e.data?.node === "act");
      assert.ok(actStarted, "act node.started must be emitted");
      assert.equal(actStarted.data.snapshot, undefined, "snapshot field must not be set");
      assert.equal("snapshot" in actStarted.data, false, "snapshot field must be absent from payload");
    } finally {
      await engine.kill();
      removeDir(dir);
      removeDir(nonGitWorkspace);
    }
  });

  it("(e) A forced snapshot failure: the step still completes", async () => {
    const dir = tempDir("snapshot-forced-fail");
    const workspaceDir = tempWorkspaceDir();
    const workspace = makeWorkspace(workspaceDir, { "file.txt": "forced-fail\n" });

    // Make .git/refs read-only so git update-ref fails
    const refsDir = path.join(workspace, ".git", "refs");
    fs.chmodSync(refsDir, 0o555);

    try {
      // createStepSnapshot logs error and returns null without throwing
      const snap = await createStepSnapshot(workspace, "fail-mission", 1);
      assert.equal(snap, null);

      // Now run a mission in this workspace with failing snapshot
      const agent = writeAgent(dir, [
        { claim: "step with failed snapshot", review: { accept: true, note: "ok" } },
      ]);
      trustFolder(dir, workspace);
      const engine = new EngineProcess(dir, ["--scripted-agent", agent]);
      try {
        const start = await engine.request("req-1", "mission.Missions.start", {
          workspaceRoot: workspace,
          title: "snapshot fail mission",
          initialQuery: "continue despite snapshot failure",
          checkCommand: "true",
        });
        assert.equal(start.error, undefined);
        const missionId = start.result.missionId;
        const final = await waitForMissionEnd(engine, missionId);
        assert.equal(final.status, "verified", "mission must still reach verified despite snapshot failure");

        const events = await readMissionEvents(dir, missionId);
        const actStarted = events.find((e) => e.kind === "node.started" && e.data?.node === "act");
        assert.ok(actStarted);
        assert.equal(actStarted.data.snapshot, undefined);
      } finally {
        await engine.kill();
      }
    } finally {
      fs.chmodSync(refsDir, 0o755);
      removeDir(dir);
      removeDir(workspaceDir);
    }
  });
});
