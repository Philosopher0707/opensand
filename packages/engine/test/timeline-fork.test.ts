import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  EventLogReader,
  EventLogWriter,
  FolderTrustStore,
  GrantsStore,
  MISSION_EVENT,
  type SessionEvent,
} from "@opensand/shared";
import { ErrorCodes, OspError } from "@opensand/protocol";
import {
  EngineProcess,
  removeDir,
  tempDir,
  trustFolder,
  cleanGitEnv,
} from "./helpers.js";
import {
  createStepSnapshot,
  treeOf,
  restoreSnapshot,
} from "../src/missions/workspace-diff.js";
import { MissionRunnerManager } from "../src/missions/manager.js";
import { FolderTrustGate } from "../src/missions/trust-gate.js";
import { EngineServer } from "../src/server.js";

function git(args: string[], cwd: string, options: { input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input: options.input,
    env: { ...cleanGitEnv(), ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function makeGitWorkspace(root: string, files: Record<string, string>): string {
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

function shasumFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

async function createParentMissionLog(
  stateDir: string,
  missionId: string,
  workspaceRoot: string,
  options: {
    title?: string;
    initialQuery?: string;
    checkCommand?: string;
    budgetUsd?: number;
    maxRepairs?: number;
    steps?: Array<{ kind: string; data: Record<string, any> }>;
  } = {}
) {
  const dir = path.join(stateDir, "missions", missionId);
  fs.mkdirSync(dir, { recursive: true });
  const writer = new EventLogWriter(dir, { sessionId: missionId });

  await writer.append({
    sessionId: missionId,
    kind: MISSION_EVENT.STARTED,
    data: {
      missionId,
      workspaceRoot,
      title: options.title ?? "Parent Mission Title",
      initialQuery: options.initialQuery ?? "Initial instructions",
      checkCommand: options.checkCommand ?? "npm test",
      budget: {
        budgetUsd: options.budgetUsd ?? 5,
        maxRepairs: options.maxRepairs ?? 3,
      },
    },
  });

  if (options.steps) {
    for (const s of options.steps) {
      await writer.append({
        sessionId: missionId,
        kind: s.kind,
        data: s.data,
      });
    }
  }
}

describe("Time Machine Fork: timeline.Timeline.get and fork", () => {
  it("Test 1 (§2): Git-invariant Witness Test", async () => {
    const root = tempDir("tf-witness");
    try {
      const workspace = makeGitWorkspace(root, {
        "tracked.txt": "step 0 content",
      });
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      trustFolder(stateDir, workspace);

      const parentId = "m-parent1";

      // Step 1: modify tracked.txt and snapshot
      fs.writeFileSync(path.join(workspace, "tracked.txt"), "step 1 content", "utf8");
      const snap1 = await createStepSnapshot(workspace, parentId, 1);
      assert.ok(snap1?.ref);

      // Step 2: modify tracked.txt, add step2.txt, and snapshot
      fs.writeFileSync(path.join(workspace, "tracked.txt"), "step 2 content", "utf8");
      fs.writeFileSync(path.join(workspace, "step2.txt"), "step 2 file", "utf8");
      const snap2 = await createStepSnapshot(workspace, parentId, 2);
      assert.ok(snap2?.ref);

      // Add a git stash
      fs.writeFileSync(path.join(workspace, "stash-me.txt"), "stash me", "utf8");
      git(["stash", "push", "-u", "-m", "user stash"], workspace);

      // Create a user branch
      git(["branch", "user-feature"], workspace);

      // Record pre-fork witness
      const preHeadRev = git(["rev-parse", "HEAD"], workspace).trim();
      const preSymbolicHead = git(["symbolic-ref", "HEAD"], workspace).trim();
      const preIndexSha = shasumFile(path.join(workspace, ".git", "index"));
      const preStashList = git(["stash", "list"], workspace).trim();
      const preBranchList = git(["branch", "--list"], workspace).trim();

      // Create parent mission log
      await createParentMissionLog(stateDir, parentId, workspace, {
        steps: [
          { kind: MISSION_EVENT.NODE_STARTED, data: { node: "act", snapshot: snap1.ref } },
          { kind: MISSION_EVENT.NODE_COMPLETED, data: { node: "act", claim: "Step 1 done" } },
          { kind: MISSION_EVENT.NODE_STARTED, data: { node: "repair", snapshot: snap2.ref } },
          { kind: MISSION_EVENT.NODE_COMPLETED, data: { node: "repair", claim: "Step 2 done" } },
        ],
      });

      const manager = new MissionRunnerManager(stateDir, undefined, () => {}, { baseDir: stateDir });

      // Fork to step 1
      const forkResult = await manager.fork(
        {
          missionId: parentId,
          snapshot: 1,
        },
        stateDir
      );

      assert.strictEqual(forkResult.success, true);
      assert.strictEqual(forkResult.forkedFrom.missionId, parentId);
      assert.strictEqual(forkResult.forkedFrom.snapshot, snap1.ref);
      assert.strictEqual(forkResult.forkedFrom.targetTree, snap1.tree);

      // Workspace files check: tracked.txt is at step 1; step2.txt is deleted
      const trackedContent = fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8");
      assert.strictEqual(trackedContent, "step 1 content");
      assert.strictEqual(fs.existsSync(path.join(workspace, "step2.txt")), false);

      // treeOf(workspace) matches snap1.tree
      const currTree = await treeOf(workspace);
      assert.strictEqual(currTree.available, true);
      assert.strictEqual(currTree.tree, snap1.tree);

      // Byte-for-byte git invariant assertions
      const postHeadRev = git(["rev-parse", "HEAD"], workspace).trim();
      const postSymbolicHead = git(["symbolic-ref", "HEAD"], workspace).trim();
      const postIndexSha = shasumFile(path.join(workspace, ".git", "index"));
      const postStashList = git(["stash", "list"], workspace).trim();
      const postBranchList = git(["branch", "--list"], workspace).trim();

      assert.strictEqual(postHeadRev, preHeadRev, "HEAD rev must be byte-identical");
      assert.strictEqual(postSymbolicHead, preSymbolicHead, "symbolic-ref HEAD must be byte-identical");
      assert.strictEqual(postIndexSha, preIndexSha, "sha256(.git/index) must be strictly unchanged");
      assert.strictEqual(postStashList, preStashList, "git stash list must be byte-identical");
      assert.strictEqual(postBranchList, preBranchList, "branch list must be byte-identical");
    } finally {
      removeDir(root);
    }
  });

  it("Test 2 (§4): Error Cases (exact JSON-RPC error codes)", async () => {
    const root = tempDir("tf-errors");
    try {
      const workspace = makeGitWorkspace(root, { "file.txt": "initial" });
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      trustFolder(stateDir, workspace);

      const parentId = "m-parent-err";
      const snap1 = await createStepSnapshot(workspace, parentId, 1);
      assert.ok(snap1?.ref);

      fs.writeFileSync(path.join(workspace, "file.txt"), "modified", "utf8");
      const snap2 = await createStepSnapshot(workspace, parentId, 2);
      assert.ok(snap2?.ref);

      await createParentMissionLog(stateDir, parentId, workspace);

      const manager = new MissionRunnerManager(stateDir, undefined, () => {}, { baseDir: stateDir });

      // 1. Missing params: missing missionId -> -32602
      await assert.rejects(
        manager.fork({ missionId: "", snapshot: 1 }, stateDir),
        (err: OspError) => {
          assert.strictEqual(err.code, ErrorCodes.InvalidParams);
          return true;
        }
      );

      // 2. Missing params: missing snapshot -> -32602
      await assert.rejects(
        manager.fork({ missionId: parentId, snapshot: "" as any }, stateDir),
        (err: OspError) => {
          assert.strictEqual(err.code, ErrorCodes.InvalidParams);
          return true;
        }
      );

      // 3. Unknown step ref: s-999 -> -32602
      await assert.rejects(
        manager.fork({ missionId: parentId, snapshot: 999 }, stateDir),
        (err: OspError) => {
          assert.strictEqual(err.code, ErrorCodes.InvalidParams);
          return true;
        }
      );

      // 4. Foreign mission ref prefix -> -32602
      await assert.rejects(
        manager.fork(
          { missionId: parentId, snapshot: "refs/opensand/missions/m-other/s-1" },
          stateDir
        ),
        (err: OspError) => {
          assert.strictEqual(err.code, ErrorCodes.InvalidParams);
          return true;
        }
      );

      // 5. Untrusted folder -> -32600
      const untrustedStateDir = path.join(root, "state-untrusted");
      fs.mkdirSync(untrustedStateDir, { recursive: true });
      const untrustedManager = new MissionRunnerManager(untrustedStateDir, undefined, () => {}, {
        baseDir: untrustedStateDir,
      });
      fs.cpSync(path.join(stateDir, "missions"), path.join(untrustedStateDir, "missions"), {
        recursive: true,
      });

      await assert.rejects(
        untrustedManager.fork({ missionId: parentId, snapshot: 1 }, untrustedStateDir),
        (err: OspError) => {
          assert.strictEqual(err.code, ErrorCodes.InvalidRequest);
          return true;
        }
      );

      // 6. Active mission running on workspace -> -32600
      (manager as any).activeRunners.set("m-running", {
        workspaceRoot: workspace,
      });
      await assert.rejects(
        manager.fork({ missionId: parentId, snapshot: 1 }, stateDir),
        (err: OspError) => {
          assert.strictEqual(err.code, ErrorCodes.InvalidRequest);
          return true;
        }
      );
      (manager as any).activeRunners.clear();

      // 7. Concurrency lock held -> -32600
      (manager as any).restoringWorkspaces.add(path.resolve(workspace));
      await assert.rejects(
        manager.fork({ missionId: parentId, snapshot: 1 }, stateDir),
        (err: OspError) => {
          assert.strictEqual(err.code, ErrorCodes.InvalidRequest);
          return true;
        }
      );
      (manager as any).restoringWorkspaces.clear();

      // 8. No-op fork: workspace is already at step 2 -> -32600
      await assert.rejects(
        manager.fork({ missionId: parentId, snapshot: 2 }, stateDir),
        (err: OspError) => {
          assert.strictEqual(err.code, ErrorCodes.InvalidRequest);
          assert.match(err.message, /No-op fork/i);
          return true;
        }
      );
    } finally {
      removeDir(root);
    }
  });

  it("Test 3 (§3): Mission Identity & State Inheritance", async () => {
    const root = tempDir("tf-inherit");
    try {
      const workspace = makeGitWorkspace(root, { "code.ts": "v0" });
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      trustFolder(stateDir, workspace);

      const parentId = "m-parent-inh";
      fs.writeFileSync(path.join(workspace, "code.ts"), "v1", "utf8");
      const snap1 = await createStepSnapshot(workspace, parentId, 1);
      assert.ok(snap1?.ref);

      fs.writeFileSync(path.join(workspace, "code.ts"), "v2", "utf8");
      const snap2 = await createStepSnapshot(workspace, parentId, 2);
      assert.ok(snap2?.ref);

      await createParentMissionLog(stateDir, parentId, workspace, {
        title: "Fix login button",
        initialQuery: "Fix the button bug",
        checkCommand: "npm run test:login",
        budgetUsd: 10,
        maxRepairs: 4,
      });

      const manager = new MissionRunnerManager(stateDir, undefined, () => {}, { baseDir: stateDir });

      const forkResult = await manager.fork(
        {
          missionId: parentId,
          snapshot: 1,
          newTitle: "Fix login button alternative",
          newInstruction: "Try alternative design",
        },
        stateDir
      );

      const newId = forkResult.newMissionId;
      assert.ok(/^m-[a-f0-9]{8}$/.test(newId), `id ${newId} must match m-<uuid8>`);
      assert.notStrictEqual(newId, parentId);

      // Check refs in git
      const baseRefTree = git(["rev-parse", `refs/opensand/missions/${newId}/base`], workspace).trim();
      assert.strictEqual(baseRefTree, snap1.tree);

      const forkParentCommit = git(["rev-parse", `refs/opensand/missions/${newId}/fork-parent`], workspace).trim();
      const expectedParentCommit = git(["rev-parse", snap1.ref], workspace).trim();
      assert.strictEqual(forkParentCommit, expectedParentCommit);

      // Check event log starts with MISSION_FORKED
      const newLogDir = path.join(stateDir, "missions", newId);
      const reader = new EventLogReader(newLogDir);
      const { events } = await reader.readWithRecovery();

      assert.strictEqual(events.length, 1);
      const firstEv = events[0];
      assert.strictEqual(firstEv.seq, 1);
      assert.strictEqual(firstEv.kind, MISSION_EVENT.FORKED);
      assert.strictEqual(firstEv.data.missionId, newId);
      assert.strictEqual(firstEv.data.title, "Fix login button alternative");
      assert.strictEqual(firstEv.data.initialQuery, "Try alternative design");
      assert.strictEqual(firstEv.data.checkCommand, "npm run test:login");
      assert.deepStrictEqual(firstEv.data.forkedFrom, {
        missionId: parentId,
        snapshot: snap1.ref,
        targetTree: snap1.tree,
      });

      // Check projectMission reflects fresh counters
      const proj = await manager.getMission(newId, stateDir);
      assert.ok(proj);
      assert.strictEqual(proj.missionId, newId);
      assert.strictEqual(proj.title, "Fix login button alternative");
      assert.strictEqual(proj.repairRounds, 0);
      assert.strictEqual(proj.budgetSpentUsd, 0);
      assert.strictEqual(proj.status, "running");
    } finally {
      removeDir(root);
    }
  });

  it("Test 4 (§5): Rollback on Mid-Restore Failure", async () => {
    const root = tempDir("tf-rollback");
    try {
      const workspace = makeGitWorkspace(root, { "file.txt": "v0" });
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      trustFolder(stateDir, workspace);

      const parentId = "m-parent-rb";
      fs.writeFileSync(path.join(workspace, "file.txt"), "v1", "utf8");
      const snap1 = await createStepSnapshot(workspace, parentId, 1);
      assert.ok(snap1?.ref);

      fs.writeFileSync(path.join(workspace, "file.txt"), "v2-modified", "utf8");
      const snap2 = await createStepSnapshot(workspace, parentId, 2);
      assert.ok(snap2?.ref);

      // Workspace at v2-modified
      await createParentMissionLog(stateDir, parentId, workspace);

      const manager = new MissionRunnerManager(stateDir, undefined, () => {}, { baseDir: stateDir });

      let thrownErr: OspError | undefined;
      try {
        await manager.fork(
          { missionId: parentId, snapshot: 1 },
          stateDir,
          { _simulateFailure: "checkout" }
        );
      } catch (err: any) {
        thrownErr = err;
      }

      assert.ok(thrownErr);
      assert.strictEqual(thrownErr.code, ErrorCodes.InternalError);
      assert.ok(thrownErr.data && (thrownErr.data as any).preRestoreSnapshot);

      // Check that NO new mission dir was created in stateDir/missions
      const missionDirs = fs.readdirSync(path.join(stateDir, "missions"));
      assert.deepStrictEqual(missionDirs, [parentId], "No new mission directory should exist after failed fork");

      // Verify workspace was rolled back to pre-restore state (file.txt has v2-modified)
      const currentContent = fs.readFileSync(path.join(workspace, "file.txt"), "utf8");
      assert.strictEqual(currentContent, "v2-modified");
    } finally {
      removeDir(root);
    }
  });

  it("Test 5 (§4): timeline.get in seq order with isRestorable", async () => {
    const root = tempDir("tf-timeline-get");
    try {
      const workspace = makeGitWorkspace(root, { "file.txt": "v0" });
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      trustFolder(stateDir, workspace);

      const missionId = "m-timeline-demo";
      const snap1 = await createStepSnapshot(workspace, missionId, 1);
      const snap2 = await createStepSnapshot(workspace, missionId, 2);

      await createParentMissionLog(stateDir, missionId, workspace, {
        title: "Test Timeline Mission",
        steps: [
          { kind: MISSION_EVENT.NODE_STARTED, data: { node: "plan" } },
          { kind: MISSION_EVENT.NODE_COMPLETED, data: { node: "plan", durationMs: 120 } },
          { kind: MISSION_EVENT.NODE_STARTED, data: { node: "act", snapshot: snap1?.ref } },
          { kind: MISSION_EVENT.NODE_COMPLETED, data: { node: "act", claim: "Created feature", durationMs: 450 } },
          { kind: MISSION_EVENT.CHECK_COMPLETED, data: { passed: true, exitCode: 0, durationMs: 80 } },
          { kind: MISSION_EVENT.REVIEW_COMPLETED, data: { accept: true, note: "Looks good" } },
          { kind: MISSION_EVENT.NODE_STARTED, data: { node: "repair", snapshot: snap2?.ref } },
          { kind: MISSION_EVENT.NODE_COMPLETED, data: { node: "repair", claim: "Fixed edge case", durationMs: 200 } },
          { kind: MISSION_EVENT.VERIFIED, data: { status: "VERIFIED" } },
        ],
      });

      const manager = new MissionRunnerManager(stateDir, undefined, () => {}, { baseDir: stateDir });

      const res = await manager.timelineGet({ missionId }, stateDir);
      assert.strictEqual(res.missionId, missionId);
      assert.ok(Array.isArray(res.steps));
      assert.ok(res.steps.length >= 6);

      // Assert seq order
      for (let i = 1; i < res.steps.length; i++) {
        assert.ok(
          res.steps[i].seq >= res.steps[i - 1].seq,
          `steps must be in seq order: ${res.steps[i].seq} >= ${res.steps[i - 1].seq}`
        );
      }

      // Assert isRestorable is boolean and true only on steps with restorable snapshot
      const actStep = res.steps.find((s: any) => s.node === "act");
      assert.ok(actStep);
      assert.strictEqual(actStep.isRestorable, true);
      assert.strictEqual(actStep.snapshotRef, snap1?.ref);

      const repairStep = res.steps.find((s: any) => s.node === "repair");
      assert.ok(repairStep);
      assert.strictEqual(repairStep.isRestorable, true);
      assert.strictEqual(repairStep.snapshotRef, snap2?.ref);

      const startStep = res.steps.find((s: any) => s.node === "start");
      assert.ok(startStep);
      assert.strictEqual(startStep.isRestorable, false);

      const checkStep = res.steps.find((s: any) => s.node === "check");
      assert.ok(checkStep);
      assert.strictEqual(checkStep.isRestorable, false);

      const endStep = res.steps.find((s: any) => s.node === "end");
      assert.ok(endStep);
      assert.strictEqual(endStep.isRestorable, false);

      // Test error on missing / invalid missionId
      await assert.rejects(
        manager.timelineGet({ missionId: "" }, stateDir),
        (err: OspError) => err.code === ErrorCodes.InvalidParams
      );
      await assert.rejects(
        manager.timelineGet({ missionId: "non-existent" }, stateDir),
        (err: OspError) => err.code === ErrorCodes.InvalidParams
      );
    } finally {
      removeDir(root);
    }
  });

  it("Test 6 (§4): OSP Protocol Wire Integration", async () => {
    const root = tempDir("tf-wire");
    try {
      const workspace = makeGitWorkspace(root, { "app.ts": "console.log(1);" });
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      trustFolder(stateDir, workspace);

      const parentId = "m-wire-parent";
      fs.writeFileSync(path.join(workspace, "app.ts"), "console.log(2);", "utf8");
      const snap1 = await createStepSnapshot(workspace, parentId, 1);
      assert.ok(snap1?.ref);

      fs.writeFileSync(path.join(workspace, "app.ts"), "console.log(3);", "utf8");
      const snap2 = await createStepSnapshot(workspace, parentId, 2);
      assert.ok(snap2?.ref);

      await createParentMissionLog(stateDir, parentId, workspace, {
        steps: [
          { kind: MISSION_EVENT.NODE_STARTED, data: { node: "act", snapshot: snap1.ref } },
          { kind: MISSION_EVENT.NODE_COMPLETED, data: { node: "act", claim: "Step 1" } },
        ],
      });

      const engine = new EngineProcess(stateDir);
      try {
        // Test timeline.Timeline.get
        const getRes = await engine.request("req-tl-get", "timeline.Timeline.get", {
          missionId: parentId,
        });
        assert.strictEqual(getRes.id, "req-tl-get");
        assert.ok(getRes.result);
        assert.strictEqual(getRes.result.missionId, parentId);
        assert.ok(getRes.result.steps.length > 0);

        // Test timeline.Timeline.fork
        const forkRes = await engine.request("req-tl-fork", "timeline.Timeline.fork", {
          missionId: parentId,
          snapshot: 1,
        });
        assert.strictEqual(forkRes.id, "req-tl-fork");
        assert.ok(forkRes.result);
        assert.strictEqual(forkRes.result.success, true);
        assert.ok(forkRes.result.newMissionId);
        assert.strictEqual(forkRes.result.forkedFrom.snapshot, snap1.ref);

        // Verify workspace is at step 1
        assert.strictEqual(fs.readFileSync(path.join(workspace, "app.ts"), "utf8"), "console.log(2);");
      } finally {
        await engine.kill();
      }
    } finally {
      removeDir(root);
    }
  });
});
