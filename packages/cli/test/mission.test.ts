import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventLogWriter } from "@opensand/shared";
import { runMissionCommand } from "../src/mission.js";

function captureConsole(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  return fn()
    .then(() => ({ out: out.join("\n"), err: err.join("\n") }))
    .finally(() => {
      console.log = log;
      console.error = error;
    });
}

async function tempStateWithMission(missionId: string): Promise<string> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-mission-"));
  const dir = path.join(stateDir, "missions", missionId);
  await fs.mkdir(dir, { recursive: true });
  const writer = new EventLogWriter(dir, { sessionId: missionId });
  await writer.append({
    sessionId: missionId,
    node: "plan",
    kind: "mission.started",
    data: { missionId, title: "make the check pass", workspaceRoot: stateDir, budgetUsd: 0 },
  });
  return stateDir;
}

test("mission verbs print usage when called without arguments", async () => {
  const captured = await captureConsole(() => runMissionCommand(["mission"]));
  assert.match(captured.out, /opensand mission tournament/);
  assert.match(captured.out, /opensand mission attempt restore/);
});

test("mission reconcile on a mission without a tournament reports nothing to do", async () => {
  const stateDir = await tempStateWithMission("m-cli");
  try {
    const captured = await captureConsole(() =>
      runMissionCommand(["mission", "reconcile", "m-cli", "--state-dir", stateDir]),
    );
    assert.match(captured.out, /nothing to do/);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("mission attempt restore without a numeric attempt prints usage and exits", async () => {
  const stateDir = await tempStateWithMission("m-cli");
  try {
    const savedExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as typeof process.exit;
    try {
      await assert.rejects(() =>
        captureConsole(() => runMissionCommand(["mission", "attempt", "restore", "abc", "--state-dir", stateDir])),
      );
      assert.equal(exitCode, 2);
    } finally {
      process.exit = savedExit;
    }
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("mission reconcile on an unknown mission dir is a no-op report", async () => {
  const stateDir = await tempStateWithMission("m-cli");
  try {
    const captured = await captureConsole(() =>
      runMissionCommand(["mission", "reconcile", "m-missing", "--state-dir", stateDir]),
    );
    // The engine reconcile replays from the tournament record; no record, no actions.
    assert.match(captured.out, /Reconcile m-missing/);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
