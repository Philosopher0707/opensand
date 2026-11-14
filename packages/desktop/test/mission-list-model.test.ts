import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLogWriter } from "@opensand/shared";
import {
  sortMissions,
  toMissionRow,
  statusLabel,
  missionEmptyState,
  nextIndex,
  type MissionSummary,
} from "../src/shell/mission-list-model.js";
import { listMissionSummaries } from "../src/shell/mission-list-source.js";

const m = (id: string, status: string, updatedAt: string, title = id): MissionSummary => ({
  missionId: id,
  title,
  status,
  updatedAt,
});

test("mission-list-model: sorts newest update first, undated last, stable on ties", () => {
  const sorted = sortMissions([
    m("b", "running", "2026-11-14T10:00:00Z"),
    m("z", "failed", "not-a-date"),
    m("c", "verified", "2026-11-14T12:00:00Z"),
    m("a", "running", "2026-11-14T10:00:00Z"),
  ]);
  assert.deepStrictEqual(sorted.map((x) => x.missionId), ["c", "a", "b", "z"]);
});

test("mission-list-model: sort does not mutate its input", () => {
  const input = [m("a", "running", "2026-01-01T00:00:00Z"), m("b", "running", "2026-02-01T00:00:00Z")];
  sortMissions(input);
  assert.deepStrictEqual(input.map((x) => x.missionId), ["a", "b"]);
});

test("mission-list-model: each status has its own label", () => {
  assert.strictEqual(statusLabel("planned"), "Queued");
  assert.strictEqual(statusLabel("running"), "Running");
  assert.strictEqual(statusLabel("needs-you"), "Waiting for you");
  assert.strictEqual(statusLabel("verified"), "Done");
  assert.strictEqual(statusLabel("failed"), "Failed");
  assert.strictEqual(statusLabel("stopped"), "Stopped");
  assert.strictEqual(statusLabel("???"), "Unknown");
});

test("mission-list-model: toMissionRow marks the active row and falls back to id for a blank title", () => {
  const row = toMissionRow(m("mis-1", "needs-you", "2026-11-14T10:00:00Z", ""), "2 hours ago", "mis-1");
  assert.strictEqual(row.title, "mis-1");
  assert.strictEqual(row.statusLabel, "Waiting for you");
  assert.strictEqual(row.timeLabel, "2 hours ago");
  assert.strictEqual(row.active, true);
  assert.strictEqual(toMissionRow(m("mis-1", "running", ""), "", "other").active, false);
  assert.strictEqual(toMissionRow(m("mis-1", "running", ""), "", null).active, false);
});

test("mission-list-model: empty state copy", () => {
  assert.strictEqual(missionEmptyState().title, "No missions yet");
});

test("mission-list-model: arrow keys, Home and End move focus and clamp at the ends", () => {
  assert.strictEqual(nextIndex(0, "ArrowDown", 3), 1);
  assert.strictEqual(nextIndex(2, "ArrowDown", 3), 2);
  assert.strictEqual(nextIndex(1, "ArrowUp", 3), 0);
  assert.strictEqual(nextIndex(0, "ArrowUp", 3), 0);
  assert.strictEqual(nextIndex(1, "Home", 3), 0);
  assert.strictEqual(nextIndex(0, "End", 3), 2);
  assert.strictEqual(nextIndex(1, "a", 3), 1);
  assert.strictEqual(nextIndex(0, "ArrowDown", 0), -1);
});

test("mission-list-source: projects title, status and last update from real mission logs", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-missions-"));
  try {
    const write = async (id: string, events: Array<[string, any, string]>) => {
      const w = new EventLogWriter(path.join(base, "missions", id), { sessionId: id });
      for (const [kind, data, ts] of events) await w.append({ kind: kind as any, data, ts });
    };
    await write("run-1", [["mission.started", { title: "Fix the build" }, "2026-11-14T09:00:00.000Z"]]);
    await write("wait-1", [
      ["mission.started", { title: "Ask me" }, "2026-11-14T09:00:00.000Z"],
      ["mission.needs-you", {}, "2026-11-14T09:05:00.000Z"],
    ]);
    await write("done-1", [
      ["mission.started", { title: "Ship it" }, "2026-11-14T08:00:00.000Z"],
      ["mission.verified", {}, "2026-11-14T08:30:00.000Z"],
    ]);
    await write("fail-1", [
      ["mission.started", { title: "Break" }, "2026-11-14T07:00:00.000Z"],
      ["mission.failed", {}, "2026-11-14T07:10:00.000Z"],
    ]);
    fs.mkdirSync(path.join(base, "missions", "corrupt-1"), { recursive: true });
    fs.writeFileSync(path.join(base, "missions", "corrupt-1", "event-log.jsonl"), "{not json}\n");

    const got = await listMissionSummaries(base);
    const byId = Object.fromEntries(got.map((x) => [x.missionId, x]));
    assert.deepStrictEqual(Object.keys(byId).sort(), ["done-1", "fail-1", "run-1", "wait-1"]);
    assert.strictEqual(byId["run-1"].status, "running");
    assert.strictEqual(byId["run-1"].title, "Fix the build");
    assert.strictEqual(byId["wait-1"].status, "needs-you");
    assert.strictEqual(byId["wait-1"].updatedAt, "2026-11-14T09:05:00.000Z");
    assert.strictEqual(byId["done-1"].status, "verified");
    assert.strictEqual(byId["fail-1"].status, "failed");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("mission-list-source: no missions directory is an empty list, not an error", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-missions-empty-"));
  try {
    assert.deepStrictEqual(await listMissionSummaries(base), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
