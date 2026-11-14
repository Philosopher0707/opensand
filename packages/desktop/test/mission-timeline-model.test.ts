import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLogWriter } from "@opensand/shared";
import {
  toTimelineSteps,
  windowSteps,
  nextLimit,
  formatStepTime,
  timelineEmptyState,
  TIMELINE_PAGE,
  type RawTimelineEvent,
} from "../src/shell/mission-timeline-model.js";
import { readMissionTimeline } from "../src/shell/mission-timeline-source.js";

const ev = (seq: number, kind: string, data: Record<string, any> = {}, ts = "2026-11-14T09:00:00.000Z"): RawTimelineEvent => ({ seq, ts, kind, data });

test("timeline: engine event shapes become ordered steps (start, plan, act, check, review, receipt, end)", () => {
  const steps = toTimelineSteps([
    ev(7, "mission.verified"),
    ev(1, "mission.started", { title: "Fix the build" }),
    ev(2, "node.started", { node: "plan" }),
    ev(3, "node.completed", { node: "plan", durationMs: 1200 }),
    ev(4, "node.completed", { node: "act", claim: "Edited\n  two files", durationMs: 3400 }),
    ev(5, "check.completed", { passed: false, exitCode: 1 }),
    ev(6, "review.completed", { accept: true, note: "Looks right" }),
    ev(8, "node.completed", { node: "check", passed: true }),
    ev(9, "node.completed", { node: "receipt", durationMs: 50 }),
    ev(10, "something.else"),
  ]);
  assert.deepStrictEqual(steps.map((s) => s.kind), ["start", "plan", "act", "check", "review", "end", "receipt"]);
  assert.strictEqual(steps[0].summary, "Fix the build");
  assert.strictEqual(steps[1].summary, "Plan finished (1.2s)");
  assert.strictEqual(steps[2].summary, "Edited two files (3.4s)");
  assert.deepStrictEqual([steps[3].summary, steps[3].tone], ["Check failed (exit 1)", "bad"]);
  assert.deepStrictEqual([steps[4].summary, steps[4].tone], ["Accepted: Looks right", "ok"]);
  assert.deepStrictEqual([steps[5].summary, steps[5].tone], ["Verified", "ok"]);
});

test("timeline: waiting-for-you, answered, failed and stopped", () => {
  const steps = toTimelineSteps([
    ev(1, "mission.needs-you", { question: "folder-trust", folder: "/work/app" }),
    ev(2, "mission.answered", { level: "trusted" }),
    ev(3, "mission.failed", { error: "budget exceeded" }),
    ev(4, "mission.stopped", { reason: "cancelled" }),
    ev(5, "tool.failed", { tool: "bash" }),
  ]);
  assert.deepStrictEqual(steps.map((s) => [s.kind, s.summary, s.tone]), [
    ["waiting", "Trust this folder? /work/app", "attention"],
    ["answered", "Answered: trusted", "neutral"],
    ["end", "Failed: budget exceeded", "bad"],
    ["end", "Stopped: cancelled", "attention"],
    ["tool", "bash", "bad"],
  ]);
});

test("timeline: empty and malformed input never throws", () => {
  assert.deepStrictEqual(toTimelineSteps([]), []);
  const steps = toTimelineSteps([{ seq: 1, ts: "x", kind: "mission.started", data: undefined as any }]);
  assert.strictEqual(steps[0].summary, "Mission started");
  assert.strictEqual(formatStepTime("x"), "—");
  assert.ok(timelineEmptyState().title);
});

test("timeline: newest 200 are shown and show-earlier reveals the rest", () => {
  const steps = toTimelineSteps(Array.from({ length: 450 }, (_, i) => ev(i + 1, "mission.answered", {}, "2026-11-14T09:00:00.000Z")));
  const w = windowSteps(steps);
  assert.strictEqual(w.visible.length, 200);
  assert.strictEqual(w.hiddenCount, 250);
  assert.strictEqual(w.visible[0].key, "251-mission.answered");
  assert.strictEqual(w.visible[199].key, "450-mission.answered");
  const more = windowSteps(steps, nextLimit(TIMELINE_PAGE, steps.length));
  assert.deepStrictEqual([more.visible.length, more.hiddenCount], [400, 50]);
  const all = windowSteps(steps, nextLimit(400, steps.length));
  assert.deepStrictEqual([all.visible.length, all.hiddenCount], [450, 0]);
  assert.strictEqual(windowSteps(steps.slice(0, 3)).hiddenCount, 0);
});

test("timeline: time is 24h wall clock in the given zone", () => {
  assert.strictEqual(formatStepTime("2026-11-14T09:05:07Z", "UTC"), "09:05:07");
  assert.strictEqual(formatStepTime("2026-11-14T21:05:07Z", "UTC"), "21:05:07");
});

test("timeline source: reads one mission, keeps only display fields, rejects unsafe ids", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-timeline-"));
  try {
    const w = new EventLogWriter(path.join(base, "missions", "m1"), { sessionId: "m1" });
    await w.append({ kind: "mission.started", data: { title: "T", workspaceRoot: "/secret/path" }, ts: "2026-11-14T09:00:00.000Z" });
    await w.append({ kind: "mission.verified", data: { receipt: "BIG RECEIPT", changes: { a: 1 }, totalCostUsd: 0 }, ts: "2026-11-14T09:01:00.000Z" });
    const events = await readMissionTimeline(base, "m1");
    assert.deepStrictEqual(events.map((e) => e.kind), ["mission.started", "mission.verified"]);
    assert.deepStrictEqual(events[0].data, { title: "T" });
    assert.deepStrictEqual(events[1].data, {});
    assert.deepStrictEqual(await readMissionTimeline(base, "nope"), []);
    for (const bad of ["../m1", "a/b", "", ".hidden", 5, undefined]) {
      await assert.rejects(readMissionTimeline(base, bad as any), /Invalid mission id/, String(bad));
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
