import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLogWriter, EventLogReader } from "@opensand/shared";
import { createMissionFork } from "../src/mission-fork.js";
import { makeGitWorkspace, runScriptedMission, trustFolderIn, git } from "./engine-mission-fixture.js";

const SPEC = [
  { writes: { "file.txt": "step1\n", "extra.txt": "made by step 1\n" }, review: { accept: false, note: "again" } },
  { writes: { "file.txt": "step2\n" }, review: { accept: true, note: "ok" } },
];

async function realMission() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opensand-fork-home-")));
  const stateDir = path.join(home, ".opensand");
  const ws = makeGitWorkspace({ "file.txt": "initial\n" });
  trustFolderIn(stateDir, ws);
  const m = await runScriptedMission(stateDir, ws, SPEC);
  return {
    home,
    stateDir,
    ws,
    ...m,
    done: () => {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    },
  };
}

test("fork wiring: a real finished mission forks from a step on disk, creates new mission, and updates files", async () => {
  const r = await realMission();
  try {
    assert.ok(r.snapshots.length >= 2, `expected >=2 snapshots, got ${r.snapshots.length}`);
    assert.strictEqual(fs.readFileSync(path.join(r.ws, "file.txt"), "utf8"), "step2\n");
    assert.ok(fs.existsSync(path.join(r.ws, "extra.txt")));

    const fork = createMissionFork(r.stateDir);
    const res = await fork(r.missionId, r.snapshots[0], {
      newTitle: "Custom Fork Title",
      newInstruction: "Focus only on core feature",
    });

    assert.strictEqual(res.success, true);
    assert.ok(res.newMissionId.startsWith("m-"));
    assert.notStrictEqual(res.newMissionId, r.missionId, "new mission has its own id");
    assert.strictEqual(res.forkedFrom.missionId, r.missionId);
    assert.strictEqual(res.forkedFrom.snapshot, r.snapshots[0]);
    assert.ok(res.preRestoreSnapshot.startsWith(`refs/opensand/missions/${r.missionId}/`));

    // Files on disk must now match snapshot 0
    assert.strictEqual(fs.readFileSync(path.join(r.ws, "file.txt"), "utf8"), "initial\n");
    assert.strictEqual(fs.existsSync(path.join(r.ws, "extra.txt")), false);

    // Verify git refs pinned for new mission
    const baseRef = git(["rev-parse", `refs/opensand/missions/${res.newMissionId}/base`], r.ws).trim();
    assert.strictEqual(baseRef, res.forkedFrom.targetTree);
    const forkParentSha = git(["rev-parse", `refs/opensand/missions/${res.newMissionId}/fork-parent`], r.ws).trim();
    const targetSnapSha = git(["rev-parse", r.snapshots[0]], r.ws).trim();
    assert.strictEqual(forkParentSha, targetSnapSha);

    // Verify new mission event log has MISSION_FORKED
    const newMissionLogDir = path.join(r.stateDir, "missions", res.newMissionId);
    assert.ok(fs.existsSync(newMissionLogDir), "new mission log dir exists");
    const reader = new EventLogReader(newMissionLogDir);
    const { events } = await reader.readWithRecovery();
    assert.ok(events.length >= 1, "at least 1 event in new mission log");
    assert.strictEqual(events[0].kind, "mission.forked");
    assert.strictEqual(events[0].data.title, "Custom Fork Title");
    assert.strictEqual(events[0].data.initialQuery, "Focus only on core feature");
  } finally {
    r.done();
  }
});

test("fork wiring: an untrusted folder is refused by the engine gate and nothing changes", async () => {
  const r = await realMission();
  try {
    fs.rmSync(path.join(r.stateDir, "folder-trust.json"));
    const before = fs.readFileSync(path.join(r.ws, "file.txt"), "utf8");
    await assert.rejects(createMissionFork(r.stateDir)(r.missionId, r.snapshots[0]), /untrusted/i);
    assert.strictEqual(fs.readFileSync(path.join(r.ws, "file.txt"), "utf8"), before);
  } finally {
    r.done();
  }
});

test("fork wiring: a snapshot ref of another mission is refused", async () => {
  const r = await realMission();
  try {
    const other = r.snapshots[0].replace(r.missionId, "m-other");
    await assert.rejects(createMissionFork(r.stateDir)(r.missionId, other), /does not belong/i);
    assert.strictEqual(fs.readFileSync(path.join(r.ws, "file.txt"), "utf8"), "step2\n");
  } finally {
    r.done();
  }
});

test("fork wiring: a mission whose log has not ended is actively running and refused", async () => {
  const r = await realMission();
  try {
    const w = new EventLogWriter(path.join(r.stateDir, "missions", "m-live"), { sessionId: "m-live" });
    await w.append({ kind: "mission.started" as any, data: { title: "still going", workspaceRoot: r.ws } });
    await assert.rejects(
      createMissionFork(r.stateDir)("m-live", "refs/opensand/missions/m-live/s-1"),
      /actively running/
    );
    assert.strictEqual(fs.readFileSync(path.join(r.ws, "file.txt"), "utf8"), "step2\n");
  } finally {
    r.done();
  }
});

test("fork wiring: empty ids are rejected before any engine call", async () => {
  const fork = createMissionFork(path.join(os.tmpdir(), "opensand-no-such-state"));
  await assert.rejects(fork("", "refs/x"), /required/);
  await assert.rejects(fork("m-1", ""), /required/);
});
