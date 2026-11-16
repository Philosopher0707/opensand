import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { EventLogReader, FolderTrustStore, GrantsStore, type SessionEvent } from "@opensand/shared";
import { ErrorCodes, OspError } from "@opensand/protocol";
import { EngineProcess, removeDir, tempDir, trustFolder, cleanGitEnv } from "./helpers.js";
import {
  createStepSnapshot,
  treeOf,
  pinTrees,
  restoreSnapshot,
  previewRestore,
  validateTreeSafety,
  computeFilesToDelete,
} from "../src/missions/workspace-diff.js";
import { MissionRunnerManager } from "../src/missions/manager.js";
import { FolderTrustGate } from "../src/missions/trust-gate.js";

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

describe("Time Machine PR 2: restoreSnapshot", () => {
  it("Test 1 (Risk 1 & C6): Pre-restore Safety & Undoability", async () => {
    const root = tempDir("restore-t1");
    try {
      const workspace = makeGitWorkspace(root, {
        "tracked.txt": "tracked step 0",
      });
      const missionId = "m-test1";

      // Step 1: tracked.txt updated
      fs.writeFileSync(path.join(workspace, "tracked.txt"), "tracked step 1", "utf8");
      const snap1 = await createStepSnapshot(workspace, missionId, 1);
      assert.ok(snap1);

      // Step 2: tracked.txt updated and agent file added
      fs.writeFileSync(path.join(workspace, "tracked.txt"), "tracked step 2", "utf8");
      fs.writeFileSync(path.join(workspace, "agent_step2.txt"), "agent content 2", "utf8");
      const snap2 = await createStepSnapshot(workspace, missionId, 2);
      assert.ok(snap2);

      // User makes uncommitted edits before restore
      fs.writeFileSync(path.join(workspace, "tracked.txt"), "user uncommitted edits", "utf8");
      fs.writeFileSync(path.join(workspace, "uncommitted_new.txt"), "user new file", "utf8");

      // Action: Restore to s-1
      const res = await restoreSnapshot(workspace, missionId, "s-1");
      assert.ok(res.preRestoreSnapshot);
      assert.ok(res.preRestoreSnapshot.includes(`refs/opensand/missions/${missionId}/s-pre-restore-`));

      // Verify pre-restore snapshot ref exists in git database
      const preRev = git(["rev-parse", "--verify", res.preRestoreSnapshot], workspace);
      assert.ok(preRev.trim());

      // Assert workspace tracked.txt reflects step 1
      assert.equal(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8"), "tracked step 1");
      // agent_step2.txt deleted
      assert.equal(fs.existsSync(path.join(workspace, "agent_step2.txt")), false);
      // uncommitted_new.txt preserved (never in later mission snapshots)
      assert.equal(fs.readFileSync(path.join(workspace, "uncommitted_new.txt"), "utf8"), "user new file");

      // Undo Action (C6): Restore to pre-restore ref
      const undoRes = await restoreSnapshot(workspace, missionId, res.preRestoreSnapshot);
      assert.equal(undoRes.restoredSnapshot, res.preRestoreSnapshot);

      // Assertions: workspace is byte-identical to state before first restore
      assert.equal(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8"), "user uncommitted edits");
      assert.equal(fs.readFileSync(path.join(workspace, "uncommitted_new.txt"), "utf8"), "user new file");
      assert.equal(fs.readFileSync(path.join(workspace, "agent_step2.txt"), "utf8"), "agent content 2");

      // Forced failure subtest: pass target tree SHA directly, but place blocking file at .git/refs/opensand/missions/m-test1
      // so createStepSnapshot fails when attempting to create loose ref
      const missionRefDir = path.join(workspace, ".git", "refs", "opensand", "missions", missionId);
      fs.rmSync(missionRefDir, { recursive: true, force: true });
      fs.writeFileSync(missionRefDir, "blocking file", "utf8");

      await assert.rejects(
        restoreSnapshot(workspace, missionId, snap1.tree),
        (err: any) => {
          assert.ok(err.message.includes("Failed to capture pre-restore snapshot; aborting restore"));
          return true;
        }
      );
      // Assert workspace files are completely untouched
      assert.equal(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8"), "user uncommitted edits");
    } finally {
      removeDir(root);
    }
  });

  it("Test 2 (Risk 2 & C1): Safe Deletion Invariants with adversarial C1", async () => {
    const root = tempDir("restore-t2");
    try {
      const workspace = makeGitWorkspace(root, {
        "base.txt": "base content",
        ".gitignore": "*.log\n",
      });
      const missionId = "m-test2";

      // Untracked file user_scratch.txt exists before mission starts
      fs.writeFileSync(path.join(workspace, "user_scratch.txt"), "scratch content", "utf8");
      // Ignored file debug.log exists
      fs.writeFileSync(path.join(workspace, "debug.log"), "debug log content", "utf8");

      // Capture base tree at mission start and pin it
      const baseTreeRes = await treeOf(workspace);
      assert.ok(baseTreeRes.tree);
      await pinTrees(workspace, missionId, baseTreeRes.tree);

      // Step 1: agent creates agent_step1.txt
      fs.writeFileSync(path.join(workspace, "agent_step1.txt"), "agent step 1 content", "utf8");
      const snap1 = await createStepSnapshot(workspace, missionId, 1);
      assert.ok(snap1);

      // Step 2: agent creates agent_step2.txt
      fs.writeFileSync(path.join(workspace, "agent_step2.txt"), "agent step 2 content", "utf8");
      const snap2 = await createStepSnapshot(workspace, missionId, 2);
      assert.ok(snap2);

      // User adds user_manual.txt (never tracked in any mission snapshot)
      fs.writeFileSync(path.join(workspace, "user_manual.txt"), "user manual content", "utf8");

      // C1 Adversarial Test: User creates user-new.txt after mission ends
      fs.writeFileSync(path.join(workspace, "user-new.txt"), "user new after mission", "utf8");

      // Action: Restore to s-1
      const res = await restoreSnapshot(workspace, missionId, "s-1");
      assert.ok(res);

      // Assertions:
      // agent_step2.txt is DELETED (tracked in step 2, absent in step 1)
      assert.equal(fs.existsSync(path.join(workspace, "agent_step2.txt")), false);
      // agent_step1.txt is PRESERVED (exists in target step 1)
      assert.equal(fs.readFileSync(path.join(workspace, "agent_step1.txt"), "utf8"), "agent step 1 content");
      // user_scratch.txt is PRESERVED (was untracked before mission)
      assert.equal(fs.readFileSync(path.join(workspace, "user_scratch.txt"), "utf8"), "scratch content");
      // debug.log is PRESERVED (ignored by git)
      assert.equal(fs.readFileSync(path.join(workspace, "debug.log"), "utf8"), "debug log content");
      // user_manual.txt is PRESERVED (never in any mission snapshot)
      assert.equal(fs.readFileSync(path.join(workspace, "user_manual.txt"), "utf8"), "user manual content");
      // C1: user-new.txt MUST still exist (pre-restore tree excluded from F_later)
      assert.equal(fs.readFileSync(path.join(workspace, "user-new.txt"), "utf8"), "user new after mission");
    } finally {
      removeDir(root);
    }
  });

  it("Test 3 (Risk 3 & C2): Git State Preservation (HEAD, branch, diff --cached, stash, index)", async () => {
    const root = tempDir("restore-t3");
    try {
      const workspace = makeGitWorkspace(root, {
        "tracked.txt": "v1",
      });
      const missionId = "m-test3";

      // Custom branch
      git(["checkout", "-b", "feature/my-test"], workspace);

      // Snapshot 1
      const snap1 = await createStepSnapshot(workspace, missionId, 1);
      assert.ok(snap1);

      // Step 2
      fs.writeFileSync(path.join(workspace, "tracked.txt"), "v2", "utf8");
      const snap2 = await createStepSnapshot(workspace, missionId, 2);
      assert.ok(snap2);

      // User creates a stash
      fs.writeFileSync(path.join(workspace, "stashed_file.txt"), "stash me", "utf8");
      git(["stash", "push", "-m", "my-stash", "--include-untracked"], workspace);

      // User stages a file
      fs.writeFileSync(path.join(workspace, "staged.txt"), "staged file content", "utf8");
      git(["add", "staged.txt"], workspace);

      // Record git state before restore
      const headBefore = git(["rev-parse", "HEAD"], workspace);
      const symrefBefore = git(["symbolic-ref", "-q", "HEAD"], workspace);
      const diffCachedBefore = git(["diff", "--cached"], workspace);
      const stashBefore = git(["stash", "list"], workspace);
      const indexBytesBefore = fs.readFileSync(path.join(workspace, ".git", "index"));

      // Action: Restore to s-1
      const res = await restoreSnapshot(workspace, missionId, "s-1");
      assert.ok(res);

      // Assertions:
      assert.equal(git(["symbolic-ref", "-q", "HEAD"], workspace), symrefBefore);
      assert.equal(git(["rev-parse", "HEAD"], workspace), headBefore);
      assert.equal(git(["diff", "--cached"], workspace), diffCachedBefore);
      assert.equal(git(["stash", "list"], workspace), stashBefore);
      // C2: .git/index is byte-identical
      const indexBytesAfter = fs.readFileSync(path.join(workspace, ".git", "index"));
      assert.ok(indexBytesBefore.equals(indexBytesAfter), ".git/index must be byte-identical after success");
    } finally {
      removeDir(root);
    }
  });

  it("Test 4 (Risk 4): Concurrency & Active Mission Rejection", async () => {
    const root = tempDir("restore-t4");
    try {
      const workspace = makeGitWorkspace(root, { "file.txt": "init" });
      const missionId = "m-active";
      const snap = await createStepSnapshot(workspace, missionId, 1);
      assert.ok(snap);

      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      trustFolder(stateDir, workspace);

      const manager = new MissionRunnerManager(stateDir, undefined, () => {});
      // Mount fake active runner for workspace
      (manager as any).activeRunners.set(missionId, { workspaceRoot: workspace });

      await assert.rejects(
        manager.restoreSnapshot({ missionId, snapshot: "s-1", workspaceRoot: workspace }, stateDir),
        (err: any) => {
          assert.equal(err.code, ErrorCodes.InvalidRequest);
          assert.ok(err.message.includes(`Cannot restore workspace while mission '${missionId}' is actively running`));
          return true;
        }
      );
    } finally {
      removeDir(root);
    }
  });

  it("Test 5 (Risk 5 & C2): Partial Failure Midway, Automatic Rollback & Manual Recovery", async () => {
    const root = tempDir("restore-t5");
    try {
      const workspace = makeGitWorkspace(root, {
        "tracked.txt": "v1",
      });
      const missionId = "m-test5";

      // Snapshot 1
      fs.writeFileSync(path.join(workspace, "tracked.txt"), "step 1", "utf8");
      const snap1 = await createStepSnapshot(workspace, missionId, 1);
      assert.ok(snap1);

      // Snapshot 2: updates tracked.txt
      fs.writeFileSync(path.join(workspace, "tracked.txt"), "step 2", "utf8");
      const snap2 = await createStepSnapshot(workspace, missionId, 2);
      assert.ok(snap2);

      // User has uncommitted modification before restore
      fs.writeFileSync(path.join(workspace, "tracked.txt"), "user uncommitted v2 edit", "utf8");

      // Record index before restore
      const indexBefore = fs.readFileSync(path.join(workspace, ".git", "index"));

      let caughtErr: any = null;
      try {
        await restoreSnapshot(workspace, missionId, "s-1", { _simulateFailure: "checkout" });
      } catch (err: any) {
        caughtErr = err;
      }

      assert.ok(caughtErr, "restoreSnapshot must throw midway");
      assert.equal(caughtErr.code, ErrorCodes.InternalError);
      assert.ok(caughtErr.message.includes("Restore failed midway"));
      assert.ok(caughtErr.data?.preRestoreSnapshot);
      assert.ok(caughtErr.data?.manualRecoveryCommand);

      // Assert automatic rollback restored tracked.txt
      assert.equal(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8"), "user uncommitted v2 edit");

      // C2: .git/index is byte-identical after rollback
      const indexAfterRollback = fs.readFileSync(path.join(workspace, ".git", "index"));
      assert.ok(indexBefore.equals(indexAfterRollback), ".git/index must be byte-identical after rollback");

      // C2: Running manualRecoveryCommand leaves .git/index byte-identical
      execSync(caughtErr.data.manualRecoveryCommand, {
        cwd: workspace,
        env: { ...cleanGitEnv(), PATH: process.env.PATH },
        stdio: "pipe",
      });

      const indexAfterManual = fs.readFileSync(path.join(workspace, ".git", "index"));
      assert.ok(indexBefore.equals(indexAfterManual), ".git/index must be byte-identical after manualRecoveryCommand");
    } finally {
      removeDir(root);
    }
  });

  it("Test 6 (Risk 6 & C3): Adversarial Path Safety (Traversal, Symlink Escape, Symlink Refusal, Case Collision)", async () => {
    const root = tempDir("restore-t6");
    try {
      const workspace = makeGitWorkspace(root, {
        "base.txt": "base content",
      });
      const missionId = "m-test6";
      const blobSha = git(["rev-parse", "HEAD:base.txt"], workspace).trim();

      // 6.1 Traversal Tree (../../passwd)
      const subTreeSha = git(["rev-parse", "HEAD^{tree}"], workspace).trim();
      const traversalTree = git(["mktree"], workspace, {
        input: `040000 tree ${subTreeSha}\t..\n`,
      }).trim();

      await assert.rejects(
        restoreSnapshot(workspace, missionId, traversalTree),
        (err: any) => {
          assert.equal(err.code, ErrorCodes.InvalidParams);
          assert.ok(err.message.includes("Path traversal detected in snapshot tree"));
          return true;
        }
      );

      // 6.2 Symlink Escape (/etc/passwd)
      fs.symlinkSync("/etc/passwd", path.join(workspace, "escape_link"));
      git(["add", "escape_link"], workspace);
      const escapeTree = git(["write-tree"], workspace).trim();
      git(["reset", "--hard", "HEAD"], workspace);

      await assert.rejects(
        restoreSnapshot(workspace, missionId, escapeTree),
        (err: any) => {
          assert.equal(err.code, ErrorCodes.InvalidParams);
          assert.ok(
            err.message.includes("Symlink target is absolute") ||
            err.message.includes("Symlink target escapes workspaceRoot")
          );
          return true;
        }
      );

      // 6.3 C3: Symlink Write-Through Refusal
      // Workspace has existing directory symlink: sub_link -> externalTarget
      const externalTarget = path.join(root, "external_target");
      fs.mkdirSync(externalTarget, { recursive: true });
      fs.writeFileSync(path.join(externalTarget, "secret.txt"), "secret data", "utf8");

      fs.symlinkSync(externalTarget, path.join(workspace, "sub_link"));

      // Snapshot tree wants to write sub_link/attack.txt
      const subDirTree = git(["mktree"], workspace, {
        input: `100644 blob ${blobSha}\tattack.txt\n`,
      }).trim();
      const attackTree = git(["mktree"], workspace, {
        input: `040000 tree ${subDirTree}\tsub_link\n`,
      }).trim();

      // Refuse whole restore before writing anything, naming path in error
      await assert.rejects(
        restoreSnapshot(workspace, missionId, attackTree),
        (err: any) => {
          assert.equal(err.code, ErrorCodes.InvalidRequest);
          assert.ok(err.message.includes("directory along target path is a symlink: sub_link"));
          return true;
        }
      );

      // Assert symlink and external target are untouched
      assert.ok(fs.lstatSync(path.join(workspace, "sub_link")).isSymbolicLink());
      assert.equal(fs.readFileSync(path.join(externalTarget, "secret.txt"), "utf8"), "secret data");
      assert.equal(fs.existsSync(path.join(externalTarget, "attack.txt")), false);

      // 6.4 macOS Case-folding collision (foo.txt vs FOO.txt)
      const caseTree = git(["mktree"], workspace, {
        input: `100644 blob ${blobSha}\tfoo.txt\n100644 blob ${blobSha}\tFOO.txt\n`,
      }).trim();

      if (process.platform === "darwin") {
        await assert.rejects(
          restoreSnapshot(workspace, missionId, caseTree),
          (err: any) => {
            assert.equal(err.code, ErrorCodes.InvalidRequest);
            assert.ok(err.message.includes("Case-folding collision detected between") && err.message.includes("foo.txt") && err.message.includes("FOO.txt"));
            return true;
          }
        );
      }
    } finally {
      removeDir(root);
    }
  });

  it("Test 7 (Risk 7 & C4): Caller Authorization & Permission Gate", async () => {
    const root = tempDir("restore-t7");
    try {
      const workspace = makeGitWorkspace(root, { "file.txt": "content" });
      const missionId = "m-AAA";
      const snap = await createStepSnapshot(workspace, missionId, 1);
      assert.ok(snap);

      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir, { recursive: true });

      const manager = new MissionRunnerManager(stateDir, undefined, () => {});

      // 7.1 Untrusted workspace rejection
      await assert.rejects(
        manager.restoreSnapshot({ missionId, snapshot: "s-1", workspaceRoot: workspace }, stateDir),
        (err: any) => {
          assert.equal(err.code, ErrorCodes.InvalidRequest);
          assert.equal(err.message, "Workspace folder is untrusted");
          return true;
        }
      );

      // Trust folder now
      trustFolder(stateDir, workspace);

      // 7.2 Cross-mission ref tampering rejection
      await assert.rejects(
        manager.restoreSnapshot(
          { missionId: "m-AAA", snapshot: "refs/opensand/missions/m-BBB/s-1", workspaceRoot: workspace },
          stateDir
        ),
        (err: any) => {
          assert.equal(err.code, ErrorCodes.InvalidParams);
          assert.ok(err.message.includes("Ref does not belong to mission m-AAA"));
          return true;
        }
      );

      // 7.3 Model agent exclusion check: no restore_snapshot in coordinator tools
      const currentDir = new URL(".", import.meta.url).pathname;
      const orchestratorToolsPath = path.resolve(
        currentDir,
        "../../coordinator/src/orchestrator-tools.ts"
      );
      if (fs.existsSync(orchestratorToolsPath)) {
        const toolCode = fs.readFileSync(orchestratorToolsPath, "utf8");
        assert.equal(toolCode.includes("restore_snapshot"), false, "orchestrator-tools.ts must not register restore_snapshot");
      }
    } finally {
      removeDir(root);
    }
  });

  it("Test 8 (C5): Submodule (gitlink 160000) skipping", async () => {
    const root = tempDir("restore-t8");
    try {
      const workspace = makeGitWorkspace(root, {
        "file.txt": "file content",
      });
      const missionId = "m-test8";
      const blobSha = git(["rev-parse", "HEAD:file.txt"], workspace).trim();
      const commitSha = git(["rev-parse", "HEAD"], workspace).trim();

      // Create tree with a gitlink (mode 160000)
      const subTreeSha = git(["mktree"], workspace, {
        input: `100644 blob ${blobSha}\tfile.txt\n160000 commit ${commitSha}\tsubmod\n`,
      }).trim();

      // In workspace, create submod directory with a file
      fs.mkdirSync(path.join(workspace, "submod"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "submod", "local.txt"), "local submodule state", "utf8");

      // Action: restore to subTreeSha
      const res = await restoreSnapshot(workspace, missionId, subTreeSha);
      assert.ok(res);

      // C5 assertions:
      assert.deepEqual(res.skippedSubmodules, ["submod"]);
      // submod/local.txt is completely untouched
      assert.equal(fs.readFileSync(path.join(workspace, "submod", "local.txt"), "utf8"), "local submodule state");
    } finally {
      removeDir(root);
    }
  });

  it("Test 9 (C6): Result Lists (restored, overwritten, deleted, skipped) & Undo Exactness", async () => {
    const root = tempDir("restore-t9");
    try {
      const workspace = makeGitWorkspace(root, {
        "tracked.txt": "v1",
        "another.txt": "v1",
      });
      const missionId = "m-test9";

      // Step 1: tracked.txt is v1, another.txt is v1
      const snap1 = await createStepSnapshot(workspace, missionId, 1);
      assert.ok(snap1);

      // Step 2: tracked.txt changed to v2, deleted_later.txt added
      fs.writeFileSync(path.join(workspace, "tracked.txt"), "v2", "utf8");
      fs.writeFileSync(path.join(workspace, "deleted_later.txt"), "to be deleted", "utf8");
      const snap2 = await createStepSnapshot(workspace, missionId, 2);
      assert.ok(snap2);

      // Action: restore to s-1
      const res = await restoreSnapshot(workspace, missionId, "s-1");

      // Assertions on result:
      assert.ok(res.restoredFiles.includes("tracked.txt"));
      assert.ok(res.restoredFiles.includes("another.txt"));
      assert.ok(res.overwrittenFiles.includes("tracked.txt"));
      assert.ok(!res.overwrittenFiles.includes("another.txt")); // another.txt was already v1 on disk
      assert.ok(res.deletedFiles.includes("deleted_later.txt"));
      assert.equal(res.restoredFilesCount, 2);
      assert.equal(res.deletedFilesCount, 1);
      assert.ok(res.preRestoreSnapshot);

      // Restoring to pre-restore ref undoes restore exactly
      const undo = await restoreSnapshot(workspace, missionId, res.preRestoreSnapshot);
      assert.equal(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8"), "v2");
      assert.equal(fs.readFileSync(path.join(workspace, "deleted_later.txt"), "utf8"), "to be deleted");
    } finally {
      removeDir(root);
    }
  });

  it("Protocol OSP Integration Test: mission.Missions.restoreSnapshot & C4 timeline rejection", async () => {
    const root = tempDir("restore-osp");
    try {
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir, { recursive: true });

      const workspace = makeGitWorkspace(root, { "doc.txt": "initial doc" });
      trustFolder(stateDir, workspace);

      const missionId = "m-osp-test";
      fs.writeFileSync(path.join(workspace, "doc.txt"), "step 1 doc", "utf8");
      const snap1 = await createStepSnapshot(workspace, missionId, 1);
      assert.ok(snap1);

      fs.writeFileSync(path.join(workspace, "doc.txt"), "step 2 doc", "utf8");
      const snap2 = await createStepSnapshot(workspace, missionId, 2);
      assert.ok(snap2);

      const engine = new EngineProcess(stateDir);
      try {
        // C4: timeline.Timeline.restore must return MethodNotFound
        const timelineRes = await engine.request("req-timeline", "timeline.Timeline.restore", {
          missionId,
          snapshot: "s-1",
          workspaceRoot: workspace,
        });
        assert.ok(timelineRes.error);
        assert.equal(timelineRes.error.code, ErrorCodes.MethodNotFound);

        // mission.Missions.restoreSnapshot succeeds over OSP
        const restoreRes = await engine.request("req-restore", "mission.Missions.restoreSnapshot", {
          missionId,
          snapshot: "s-1",
          workspaceRoot: workspace,
        });
        assert.ok(restoreRes.result);
        assert.equal(restoreRes.result.success, true);
        assert.equal(restoreRes.result.missionId, missionId);
        assert.ok(restoreRes.result.preRestoreSnapshot);
        assert.equal(fs.readFileSync(path.join(workspace, "doc.txt"), "utf8"), "step 1 doc");
      } finally {
        await engine.kill();
      }
    } finally {
      removeDir(root);
    }
  });
  it("Test 10 (C1): a file untracked at mission start and later added by the agent survives restore", async () => {
    const root = tempDir("restore-t10");
    try {
      const workspace = makeGitWorkspace(root, { "base.txt": "base content" });
      const missionId = "m-test10";

      // Untracked at mission start: treeOf() records it in the base tree, so it is a pre-mission user file.
      fs.writeFileSync(path.join(workspace, "user_file.txt"), "user content", "utf8");
      const baseTreeRes = await treeOf(workspace);
      assert.ok(baseTreeRes.tree);
      await pinTrees(workspace, missionId, baseTreeRes.tree);

      // Step 1: the agent deletes the user's file, so s-1 does not contain it.
      fs.unlinkSync(path.join(workspace, "user_file.txt"));
      const snap1 = await createStepSnapshot(workspace, missionId, 1);
      assert.ok(snap1);

      // Step 2: the user recreates it and the agent stages it, so s-2 does contain it.
      fs.writeFileSync(path.join(workspace, "user_file.txt"), "user content", "utf8");
      git(["add", "user_file.txt"], workspace);
      const snap2 = await createStepSnapshot(workspace, missionId, 2);
      assert.ok(snap2);

      const res = await restoreSnapshot(workspace, missionId, "s-1");
      assert.ok(res);

      // It is absent from s-1 and present in s-2, but it predates the mission: it must never be unlinked.
      assert.equal(fs.readFileSync(path.join(workspace, "user_file.txt"), "utf8"), "user content");
    } finally {
      removeDir(root);
    }
  });
});


describe("Time Machine Preview: previewRestore", () => {
  it("Preview list exactness: preview matches restore execution summary with overwritten, restored, and deleted all non-empty", async () => {
    const root = tempDir("prev-t1");
    try {
      const workspace = makeGitWorkspace(root, {
        "shared.txt": "shared v0",
        "sub/keep.txt": "sub keep v0",
      });
      const missionId = "m-prev-exact";

      // Step 1:
      // - shared.txt updated to "shared v1" (will be overwritten later)
      // - recreated.txt created (will be deleted in step 2, so restored on restore)
      fs.writeFileSync(path.join(workspace, "shared.txt"), "shared v1", "utf8");
      fs.writeFileSync(path.join(workspace, "recreated.txt"), "recreated v1", "utf8");
      const snap1 = await createStepSnapshot(workspace, missionId, 1);
      assert.ok(snap1);

      // Step 2:
      // - shared.txt updated to "shared v2"
      // - recreated.txt unlinked
      // - added_step2.txt added (will be deleted when restoring to step 1)
      fs.writeFileSync(path.join(workspace, "shared.txt"), "shared v2", "utf8");
      fs.unlinkSync(path.join(workspace, "recreated.txt"));
      fs.writeFileSync(path.join(workspace, "added_step2.txt"), "added in step 2", "utf8");
      const snap2 = await createStepSnapshot(workspace, missionId, 2);
      assert.ok(snap2);

      // Verify current workspace state before preview/restore:
      // shared.txt has v2
      // recreated.txt is absent
      // added_step2.txt is present
      assert.equal(fs.readFileSync(path.join(workspace, "shared.txt"), "utf8"), "shared v2");
      assert.equal(fs.existsSync(path.join(workspace, "recreated.txt")), false);
      assert.equal(fs.existsSync(path.join(workspace, "added_step2.txt")), true);

      // Run preview
      const preview = await previewRestore(workspace, missionId, "s-1");

      // Verify all 3 lists are non-empty
      assert.ok(preview.overwrittenFiles.length > 0, "overwrittenFiles must not be empty");
      assert.ok(preview.restoredFiles.length > 0, "restoredFiles must not be empty");
      assert.ok(preview.deletedFiles.length > 0, "deletedFiles must not be empty");

      assert.ok(preview.overwrittenFiles.includes("shared.txt"), "shared.txt must be in overwrittenFiles");
      assert.ok(preview.restoredFiles.includes("recreated.txt"), "recreated.txt must be in restoredFiles");
      assert.ok(preview.deletedFiles.includes("added_step2.txt"), "added_step2.txt must be in deletedFiles");

      // Run real restore
      const restored = await restoreSnapshot(workspace, missionId, "s-1");

      // Assert preview lists equal real restore results
      assert.deepEqual(
        [...preview.overwrittenFiles].sort(),
        [...restored.overwrittenFiles].sort(),
        "preview.overwrittenFiles must equal restore.overwrittenFiles"
      );
      assert.deepEqual(
        [...preview.restoredFiles].sort(),
        [...restored.restoredFiles].sort(),
        "preview.restoredFiles must equal restore.restoredFiles"
      );
      assert.deepEqual(
        [...preview.deletedFiles].sort(),
        [...restored.deletedFiles].sort(),
        "preview.deletedFiles must equal restore.deletedFiles"
      );
      assert.deepEqual(
        [...preview.skippedSubmodules].sort(),
        [...restored.skippedSubmodules].sort(),
        "preview.skippedSubmodules must equal restore.skippedSubmodules"
      );
      assert.equal(preview.targetTree, restored.targetTree);
      assert.equal(preview.targetRef, restored.restoredSnapshot);
    } finally {
      removeDir(root);
    }
  });

  it("Read-only witness: preview leaves refs, git status, .git/index bytes, workspace file hashes, and mission log untouched", async () => {
    const root = tempDir("prev-t2");
    try {
      const workspace = makeGitWorkspace(root, {
        "file1.txt": "v1 content",
        "nested/file2.txt": "v2 content",
      });
      const missionId = "m-prev-witness";
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      trustFolder(stateDir, workspace);

      // Step 1:
      const snap1 = await createStepSnapshot(workspace, missionId, 1);
      assert.ok(snap1);

      // Step 2:
      fs.writeFileSync(path.join(workspace, "file1.txt"), "v1 updated", "utf8");
      fs.writeFileSync(path.join(workspace, "new_file.txt"), "new content", "utf8");
      const snap2 = await createStepSnapshot(workspace, missionId, 2);
      assert.ok(snap2);

      const manager = new MissionRunnerManager(stateDir, undefined, () => {});

      // Record pre-existing mission log event
      const logDir = path.join(stateDir, "logs", "missions", missionId);
      fs.mkdirSync(logDir, { recursive: true });
      const { EventLogWriter, MISSION_EVENT } = await import("@opensand/shared");
      const writer = new EventLogWriter(logDir, { sessionId: missionId });
      await writer.append({
        sessionId: missionId,
        kind: MISSION_EVENT.STARTED,
        data: { missionId, workspaceRoot: workspace },
      });

      // Capture before witness state
      const refsBefore = git(["for-each-ref"], workspace);
      const statusBefore = git(["status", "--porcelain"], workspace);
      const indexBefore = fs.readFileSync(path.join(workspace, ".git", "index"));

      const fileHashesBefore = new Map<string, string>();
      const walkFiles = (dir: string) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (ent.name === ".git") continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            walkFiles(full);
          } else {
            const rel = path.relative(workspace, full);
            const hash = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
            fileHashesBefore.set(rel, hash);
          }
        }
      };
      walkFiles(workspace);

      const reader = new EventLogReader(logDir);
      const { events: eventsBefore } = await reader.readWithRecovery();

      // Execute preview via manager
      const preview = await manager.previewRestore(
        { missionId, snapshot: "s-1", workspaceRoot: workspace },
        stateDir
      );
      assert.ok(preview);
      assert.equal(preview.success, true);

      // Capture after witness state
      const refsAfter = git(["for-each-ref"], workspace);
      const statusAfter = git(["status", "--porcelain"], workspace);
      const indexAfter = fs.readFileSync(path.join(workspace, ".git", "index"));

      const fileHashesAfter = new Map<string, string>();
      walkFiles(workspace);
      for (const [k, v] of fileHashesBefore) {
        fileHashesAfter.set(k, createHash("sha256").update(fs.readFileSync(path.join(workspace, k))).digest("hex"));
      }

      const { events: eventsAfter } = await reader.readWithRecovery();

      // Assert read-only witness invariant
      assert.equal(refsAfter, refsBefore, "Witness check: git for-each-ref must be identical");
      assert.equal(statusAfter, statusBefore, "Witness check: git status --porcelain must be identical");
      assert.deepEqual(indexAfter, indexBefore, "Witness check: .git/index bytes must be identical");
      assert.deepEqual(Object.fromEntries(fileHashesAfter), Object.fromEntries(fileHashesBefore), "Witness check: all file hashes must be identical");
      assert.deepEqual(eventsAfter, eventsBefore, "Witness check: mission event log must gain 0 events");
    } finally {
      removeDir(root);
    }
  });

  it("Security gates: Untrusted folder and foreign mission ref are refused by preview", async () => {
    const root = tempDir("prev-t3");
    try {
      const workspace = makeGitWorkspace(root, { "file.txt": "content" });
      const missionId = "m-prev-sec";
      const snap1 = await createStepSnapshot(workspace, missionId, 1);
      assert.ok(snap1);

      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir, { recursive: true });

      const manager = new MissionRunnerManager(stateDir, undefined, () => {});

      // 1. Untrusted folder refusal:
      await assert.rejects(
        manager.previewRestore(
          { missionId, snapshot: "s-1", workspaceRoot: workspace },
          stateDir
        ),
        (err: any) => {
          assert.equal(err.code, ErrorCodes.InvalidRequest);
          assert.equal(err.message, "Workspace folder is untrusted");
          return true;
        },
        "Untrusted folder must be refused"
      );

      // Now trust the workspace folder
      trustFolder(stateDir, workspace);

      // 2. Foreign mission ref refusal via manager:
      await assert.rejects(
        manager.previewRestore(
          { missionId, snapshot: "refs/opensand/missions/foreign-mission/s-1", workspaceRoot: workspace },
          stateDir
        ),
        (err: any) => {
          assert.equal(err.code, ErrorCodes.InvalidParams);
          assert.ok(err.message.includes("Ref does not belong to mission"));
          return true;
        },
        "Foreign mission ref must be refused by manager"
      );

      // 3. Foreign mission ref refusal via workspace-diff function:
      await assert.rejects(
        previewRestore(
          workspace,
          missionId,
          "refs/opensand/missions/foreign-mission/s-1"
        ),
        (err: any) => {
          assert.equal(err.code, ErrorCodes.InvalidParams);
          assert.ok(err.message.includes("Ref does not belong to mission"));
          return true;
        },
        "Foreign mission ref must be refused by previewRestore"
      );
    } finally {
      removeDir(root);
    }
  });

  it("Protocol OSP Integration Test: mission.Missions.previewRestore succeeds over OSP without mutating disk", async () => {
    const root = tempDir("prev-t4");
    try {
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir, { recursive: true });

      const workspace = makeGitWorkspace(root, { "doc.txt": "step 0 doc" });
      trustFolder(stateDir, workspace);

      const missionId = "m-prev-osp";
      fs.writeFileSync(path.join(workspace, "doc.txt"), "step 1 doc", "utf8");
      const snap1 = await createStepSnapshot(workspace, missionId, 1);
      assert.ok(snap1);

      fs.writeFileSync(path.join(workspace, "doc.txt"), "step 2 doc", "utf8");
      const snap2 = await createStepSnapshot(workspace, missionId, 2);
      assert.ok(snap2);

      const engine = new EngineProcess(stateDir);
      try {
        const previewRes = await engine.request("req-preview", "mission.Missions.previewRestore", {
          missionId,
          snapshot: "s-1",
          workspaceRoot: workspace,
        });

        assert.ok(previewRes.result, "previewRestore must return a result object");
        assert.equal(previewRes.result.success, true);
        assert.equal(previewRes.result.missionId, missionId);
        assert.ok(previewRes.result.targetRef.includes("s-1"));
        assert.ok(Array.isArray(previewRes.result.overwrittenFiles));
        assert.ok(previewRes.result.overwrittenFiles.includes("doc.txt"));

        // Disk must NOT be modified by preview
        assert.equal(fs.readFileSync(path.join(workspace, "doc.txt"), "utf8"), "step 2 doc");
      } finally {
        await engine.kill();
      }
    } finally {
      removeDir(root);
    }
  });
});
