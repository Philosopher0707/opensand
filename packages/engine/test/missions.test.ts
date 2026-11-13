import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { EventLogReader, type SessionEvent } from "@opensand/shared";
import { EngineProcess, removeDir, tempDir, trustFolder } from "./helpers.js";
import { renderReceipt } from "../src/missions/receipt.js";

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function tempWorkspaceDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opensand-workspace-"));
}

/** A git repo with one commit, as the mission runner expects to find. */
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

/** Parses a git diff in the test itself, independently of the runner's parser. */
function parseDiffIndependently(diffText: string): Array<{ file: string; ranges: [number, number][] }> {
  const files: Array<{ file: string; ranges: [number, number][] }> = [];
  let current: { file: string; ranges: [number, number][] } | null = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ b/")) {
      current = { file: line.slice(6), ranges: [] };
      files.push(current);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      current.ranges.push([start, start + count - 1]);
    }
  }
  return files.filter((file) => file.ranges.length > 0);
}

describe("mission runner", () => {
  it("ends failed when the agent claims success but the check fails", async () => {
    const dir = tempDir("false-claim");
    const workspaceDir = tempWorkspaceDir();
    const workspace = makeWorkspace(workspaceDir, { "README.md": "# demo\n" });
    const agent = writeAgent(dir, [
      { claim: "all tests pass", review: { accept: true, note: "looks good" } },
    ]);
    trustFolder(dir, workspace);
    const engine = new EngineProcess(dir, ["--scripted-agent", agent]);
    try {
      const start = await engine.request("req-1", "mission.Missions.start", {
        workspaceRoot: workspace,
        title: "false claim",
        initialQuery: "make it work",
        checkCommand: 'node -e "process.exit(1)"',
        maxRepairs: 2,
      });
      assert.equal(start.error, undefined);
      const missionId = start.result.missionId;
      assert.equal(start.result.status, "running");

      const final = await waitForMissionEnd(engine, missionId);
      assert.equal(final.status, "failed");

      const events = await readMissionEvents(dir, missionId);
      const checks = events.filter((event) => event.kind === "check.completed");
      assert.equal(checks.length, 3, "one check per repair round, plus the first");
      assert.ok(
        checks.every((check) => check.data.passed === false),
        "every check record says the check failed"
      );
      assert.equal(
        events.filter((event) => event.kind === "mission.verified").length,
        0,
        "a false claim never produces a verified record"
      );

      const receipt = final.receipt;
      assert.equal(receipt.status, "FAILED");
      assert.ok(
        renderReceipt(receipt).startsWith("FAILED"),
        `receipt starts with FAILED: ${renderReceipt(receipt)}`
      );
      assert.ok(
        renderReceipt(receipt).includes("(model note; unverified)"),
        "the agent's claim is shown as an unverified model note"
      );
    } finally {
      await engine.kill();
      removeDir(dir);
      removeDir(workspaceDir);
    }
  });

  it("verifies a passing mission, streams it live, and its receipt equals git diff", async () => {
    const dir = tempDir("verify");
    const workspaceDir = tempWorkspaceDir();
    const workspace = makeWorkspace(workspaceDir, {
      "README.md": "# demo\nline two\nline three\n",
    });
    const agent = writeAgent(dir, [
      {
        claim: "added src/a.txt and fixed the README",
        writes: { "src/a.txt": "one\ntwo\nthree\n" },
        edits: [{ path: "README.md", replaceLine: { line: 2, text: "line two edited" } }],
        review: { accept: true, note: "the diff matches the goal" },
      },
    ]);
    trustFolder(dir, workspace);
    const engine = new EngineProcess(dir, ["--scripted-agent", agent]);
    try {
      const subscribe = await engine.request("req-1", "mission.Missions.subscribe", {});
      assert.equal(subscribe.result.subscribed, true);

      const indexPath = path.join(workspace, ".git", "index");
      const indexBefore = fs.readFileSync(indexPath);
      const headBefore = git(["rev-parse", "HEAD"], workspace).trim();
      const stashBefore = git(["stash", "list"], workspace);

      const start = await engine.request("req-2", "mission.Missions.start", {
        workspaceRoot: workspace,
        title: "real work",
        initialQuery: "add a file and fix the readme",
        checkCommand: "test -f src/a.txt",
      });
      const missionId = start.result.missionId;

      const frame = await engine.waitFor(
        (candidate) => candidate.event === "mission.Missions.completed",
        20_000
      );
      assert.equal((frame.data as { missionId: string }).missionId, missionId);

      const final = await waitForMissionEnd(engine, missionId);
      assert.equal(final.status, "verified");
      assert.equal(final.receipt.status, "VERIFIED");

      // The runner must not touch the user's index, branch or stash.
      assert.deepEqual(
        fs.readFileSync(indexPath),
        indexBefore,
        "the runner must leave the user's index untouched"
      );
      assert.equal(git(["rev-parse", "HEAD"], workspace).trim(), headBefore);
      assert.equal(git(["stash", "list"], workspace), stashBefore);

      const status = git(["status", "--porcelain"], workspace);
      const statusLines = status.split("\n").filter(Boolean);
      assert.ok(statusLines.length > 0, "the agent's edits show up as working tree changes");
      assert.ok(
        statusLines.every((line) => line[0] === " " || line[0] === "?"),
        `nothing may be staged by the runner:\n${status}`
      );

      // The receipt's changed lines equal an independently computed git diff.
      const cloneDir = path.join(workspaceDir, "clone");
      git(["clone", "-q", workspace, cloneDir], workspaceDir);
      fs.cpSync(workspace, cloneDir, {
        recursive: true,
        filter: (src) => path.basename(src) !== ".git",
      });
      git(["add", "-A"], cloneDir);
      const finalTree = git(["write-tree"], cloneDir).trim();
      const diffText = git(
        ["diff", "--unified=0", "--no-color", "HEAD^{tree}", finalTree],
        cloneDir
      );
      const expected = parseDiffIndependently(diffText);
      assert.deepEqual(
        final.receipt.changed.map((change: any) => ({
          file: change.file,
          ranges: change.ranges,
        })),
        expected
      );
      assert.deepEqual(expected, [
        { file: "README.md", ranges: [[2, 2]] },
        { file: "src/a.txt", ranges: [[1, 3]] },
      ]);
    } finally {
      await engine.kill();
      removeDir(dir);
      removeDir(workspaceDir);
    }
  });

  it("loops a rejected review back to repair", async () => {
    const dir = tempDir("reject");
    const workspaceDir = tempWorkspaceDir();
    const workspace = makeWorkspace(workspaceDir, { "README.md": "# demo\n" });
    const agent = writeAgent(dir, [
      { review: { accept: false, note: "not good enough" } },
      { review: { accept: true, note: "now it is right" } },
    ]);
    trustFolder(dir, workspace);
    const engine = new EngineProcess(dir, ["--scripted-agent", agent]);
    try {
      const start = await engine.request("req-1", "mission.Missions.start", {
        workspaceRoot: workspace,
        title: "review loop",
        initialQuery: "do the thing",
        checkCommand: "true",
      });
      const missionId = start.result.missionId;
      const final = await waitForMissionEnd(engine, missionId);
      assert.equal(final.status, "verified");

      const events = await readMissionEvents(dir, missionId);
      const nodeOrder = events
        .filter((event) => event.kind === "node.started")
        .map((event) => event.data.node);
      assert.deepEqual(nodeOrder, [
        "plan",
        "act",
        "check",
        "review",
        "repair",
        "act",
        "check",
        "review",
        "receipt",
      ]);
    } finally {
      await engine.kill();
      removeDir(dir);
      removeDir(workspaceDir);
    }
  });

  it("survives a kill in the middle of a check and never claims verified", async () => {
    const dir = tempDir("kill");
    const workspaceDir = tempWorkspaceDir();
    const workspace = makeWorkspace(workspaceDir, { "README.md": "# demo\n" });
    const agent = writeAgent(dir, [{ claim: "all tests pass", review: { accept: true, note: "ok" } }]);
    trustFolder(dir, workspace);
    const engine = new EngineProcess(dir, ["--scripted-agent", agent]);
    let missionId = "";
    try {
      await engine.request("req-0", "mission.Missions.subscribe", {});
      const start = await engine.request("req-1", "mission.Missions.start", {
        workspaceRoot: workspace,
        title: "killed mid check",
        initialQuery: "take your time",
        checkCommand: "sleep 5",
      });
      missionId = start.result.missionId;
      await engine.waitFor(
        (frame) =>
          frame.event === "mission.Missions.nodeStarted" &&
          (frame.data as { node: string }).node === "check",
        20_000
      );
      await engine.kill("SIGKILL");
    } finally {
      await engine.kill();
    }

    const reader = new EventLogReader(path.join(dir, "missions", missionId));
    const chain = await reader.verifyChain();
    assert.equal(chain.valid, true, "the log chain survives the kill");
    const events = await reader.readAll();
    assert.ok(events.length > 0);
    assert.equal(
      events.filter((event) => event.kind === "mission.verified").length,
      0,
      "a killed mission is never verified"
    );

    const restarted = new EngineProcess(dir);
    try {
      const get = await restarted.request("req-1", "mission.Missions.get", { missionId });
      assert.equal(get.result.status, "running");

      const reconnect = await restarted.request("req-2", "engine.Engine.reconnect", {
        missionId,
        lastSeq: 0,
      });
      assert.equal(reconnect.result.replayedEvents, events.length);
      const replayed = restarted.frames.filter((frame) => frame.event !== undefined);
      assert.deepEqual(
        replayed.map((frame) => frame.seq),
        events.map((event) => event.seq),
        "every record is replayed once, in order"
      );
    } finally {
      await restarted.kill();
      removeDir(dir);
      removeDir(workspaceDir);
    }
  });

  it("refuses to start without a mission agent and reports pause and resume as p3b", async () => {
    const dir = tempDir("no-agent");
    const engine = new EngineProcess(dir);
    try {
      const start = await engine.request("req-1", "mission.Missions.start", {
        workspaceRoot: dir,
        title: "t",
        initialQuery: "q",
        checkCommand: "true",
      });
      assert.equal(start.error?.code, -32600);
      assert.equal(start.error?.message, "no mission agent configured");

      const pause = await engine.request("req-2", "mission.Missions.pause", { missionId: "m1" });
      assert.equal(pause.error?.code, -32601);
      assert.deepEqual(pause.error?.data, { planned: "p3b" });

      const resume = await engine.request("req-3", "mission.Missions.resume", { missionId: "m1" });
      assert.equal(resume.error?.code, -32601);
      assert.deepEqual(resume.error?.data, { planned: "p3b" });
    } finally {
      await engine.kill();
      removeDir(dir);
    }
  });
});
