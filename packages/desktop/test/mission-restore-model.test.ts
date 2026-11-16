import test from "node:test";
import assert from "node:assert";
import { toTimelineSteps, type RawTimelineEvent } from "../src/shell/mission-timeline-model.js";
import {
  isRestorableRef,
  restoreConfirmView,
  classifyRestoreError,
  restoreSuccessView,
  groupPreviewFiles,
  trapFocusIndex,
  type RestoreResult,
  type PreviewRestoreResult,
} from "../src/shell/mission-restore-model.js";

const ev = (seq: number, kind: string, data: Record<string, any> = {}): RawTimelineEvent => ({ seq, ts: "2026-11-16T09:00:00.000Z", kind, data });
const REF = "refs/opensand/missions/m-1/s-1";

test("restore: the snapshot taken by node.started lands on the step that node completes", () => {
  const steps = toTimelineSteps([
    ev(1, "mission.started", { title: "Fix" }),
    ev(2, "node.started", { node: "act", attempt: 1, snapshot: REF }),
    ev(3, "node.completed", { node: "act", claim: "Edited a.ts" }),
    ev(4, "node.started", { node: "repair", attempt: 1, snapshot: "refs/opensand/missions/m-1/s-2" }),
    ev(5, "node.completed", { node: "repair" }),
    ev(6, "node.started", { node: "plan" }),
    ev(7, "node.completed", { node: "plan" }),
  ]);
  assert.strictEqual(steps.find((s) => s.kind === "act")?.snapshot, REF);
  assert.strictEqual(steps.find((s) => s.kind === "repair")?.snapshot, "refs/opensand/missions/m-1/s-2");
  assert.strictEqual(steps.find((s) => s.kind === "plan")?.snapshot, undefined);
  assert.strictEqual(steps.find((s) => s.kind === "start")?.snapshot, undefined);
});

test("restore: a snapshot value that is not a mission ref is dropped, never offered", () => {
  assert.strictEqual(isRestorableRef(REF), true);
  assert.strictEqual(isRestorableRef("refs/opensand/missions/m-1/s-pre-restore-1794760000000"), true);
  for (const bad of ["", "HEAD", "refs/heads/main", "refs/opensand/missions/../../heads/main/s-1", "refs/opensand/missions/m-1/base", 5, null]) {
    assert.strictEqual(isRestorableRef(bad), false, String(bad));
  }
  const steps = toTimelineSteps([
    ev(1, "node.started", { node: "act", snapshot: "refs/heads/main" }),
    ev(2, "node.completed", { node: "act" }),
  ]);
  assert.strictEqual(steps[0].snapshot, undefined);
});

test("restore: the confirm dialog names the step, says it overwrites changes, and the undo", () => {
  const v = restoreConfirmView({ kindLabel: "Work", summary: "Edited a.ts (3.4s)" });
  assert.match(v.title, /Restore to this step/);
  assert.ok(v.body.includes("Edited a.ts"));
  assert.match(v.warning, /overwrit/i);
  assert.match(v.warning, /undo/i);
  assert.strictEqual(v.confirmLabel, "Confirm restore");
  assert.strictEqual(v.cancelLabel, "Cancel");
});

test("restore: errors classify as untrusted folder, running mission, or failure with a clear message", () => {
  assert.deepStrictEqual(classifyRestoreError(new Error("Workspace folder is untrusted")).kind, "untrusted");
  assert.deepStrictEqual(classifyRestoreError(new Error("Error invoking remote method: Error: Workspace folder is untrusted")).kind, "untrusted");
  assert.strictEqual(classifyRestoreError(new Error("Cannot restore workspace while mission 'm-2' is actively running. Stop or wait")).kind, "running");
  const other = classifyRestoreError(new Error("git exploded"));
  assert.strictEqual(other.kind, "failed");
  assert.match(other.message, /not changed|unchanged|no files/i);
  assert.ok(classifyRestoreError("weird").message.length > 0);
  assert.match(classifyRestoreError(new Error("Workspace folder is untrusted")).message, /trust/i);
});

test("restore: success view counts files and carries the undo target", () => {
  const r: RestoreResult = {
    success: true, missionId: "m-1", restoredSnapshot: REF,
    preRestoreSnapshot: "refs/opensand/missions/m-1/s-pre-restore-1794760000000",
    restoredFilesCount: 2, deletedFilesCount: 1,
    restoredFiles: ["a.ts", "b.ts"], overwrittenFiles: ["a.ts"], deletedFiles: ["new.ts"],
  };
  const v = restoreSuccessView(r);
  assert.match(v.message, /2 files restored/);
  assert.match(v.message, /1 file deleted/);
  assert.strictEqual(v.undoSnapshot, r.preRestoreSnapshot);
  const one = restoreSuccessView({ ...r, restoredFilesCount: 1, deletedFilesCount: 0 });
  assert.match(one.message, /1 file restored/);
  assert.doesNotMatch(one.message, /deleted/);
  assert.strictEqual(restoreSuccessView({ ...r, preRestoreSnapshot: "HEAD" }).undoSnapshot, undefined);
});

test("restore: groupPreviewFiles partitions deleted, overwritten, and recreated files correctly", () => {
  const preview: PreviewRestoreResult = {
    success: true,
    missionId: "m-1",
    targetRef: REF,
    overwrittenFiles: ["changed.ts"],
    restoredFiles: ["changed.ts", "recreated.ts"],
    deletedFiles: ["to-delete.ts"],
  };
  const g = groupPreviewFiles(preview);
  assert.deepStrictEqual(g.deletedFiles, ["to-delete.ts"]);
  assert.deepStrictEqual(g.overwrittenFiles, ["changed.ts"]);
  assert.deepStrictEqual(g.recreatedFiles, ["recreated.ts"]);
  assert.strictEqual(g.totalChanges, 3);
});

test("restore: groupPreviewFiles detects zero changes when all lists are empty", () => {
  const empty: PreviewRestoreResult = {
    success: true,
    missionId: "m-1",
    targetRef: REF,
    overwrittenFiles: [],
    restoredFiles: [],
    deletedFiles: [],
  };
  const g = groupPreviewFiles(empty);
  assert.strictEqual(g.totalChanges, 0);
  assert.deepStrictEqual(g.deletedFiles, []);
  assert.deepStrictEqual(g.overwrittenFiles, []);
  assert.deepStrictEqual(g.recreatedFiles, []);
});

test("restore: Tab and Shift+Tab wrap inside the dialog", () => {
  assert.strictEqual(trapFocusIndex(0, 2, false), 1);
  assert.strictEqual(trapFocusIndex(1, 2, false), 0);
  assert.strictEqual(trapFocusIndex(0, 2, true), 1);
  assert.strictEqual(trapFocusIndex(1, 2, true), 0);
  assert.strictEqual(trapFocusIndex(-1, 2, false), 0);
  assert.strictEqual(trapFocusIndex(-1, 2, true), 1);
  assert.strictEqual(trapFocusIndex(0, 0, false), -1);
});
