import test from "node:test";
import assert from "node:assert";
import {
  normalizeIntervalMinutes,
  validateCreateRoutineInput,
  routineStatusBadge,
  routineActionText,
  formatNextRun,
  toggleLabel,
  createInitialModalState,
  openCreateRoutineModal,
  closeCreateRoutineModal,
  ROUTINE_EMPTY_STATE,
  ROUTINE_VALIDATION_MESSAGE,
  type Routine,
  type CreateRoutineInput,
} from "../src/shell/routines-model.js";

const intervalInput: CreateRoutineInput = {
  name: "Hourly Diagnostics",
  prompt: "Check disk space and error logs",
  scheduleType: "interval",
  intervalMinutes: 60,
};

test("routines-model: normalizeIntervalMinutes defaults empty and zero to 60", () => {
  assert.strictEqual(normalizeIntervalMinutes(15), 15);
  assert.strictEqual(normalizeIntervalMinutes("30"), 30);
  assert.strictEqual(normalizeIntervalMinutes(undefined), 60);
  assert.strictEqual(normalizeIntervalMinutes(0), 60);
  assert.strictEqual(normalizeIntervalMinutes("n/a"), 60);
  assert.strictEqual(normalizeIntervalMinutes(-5), -5);
});

test("routines-model: validateCreateRoutineInput requires name and prompt", () => {
  assert.strictEqual(validateCreateRoutineInput({ ...intervalInput, name: "" }), ROUTINE_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateRoutineInput({ ...intervalInput, name: "   " }), ROUTINE_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateRoutineInput({ ...intervalInput, prompt: "  " }), ROUTINE_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateRoutineInput(intervalInput), null);
});

test("routines-model: validateCreateRoutineInput needs a cron expression for cron schedules", () => {
  const cron: CreateRoutineInput = { ...intervalInput, scheduleType: "cron" };
  assert.strictEqual(validateCreateRoutineInput(cron), "Please provide a cron expression.");
  assert.strictEqual(validateCreateRoutineInput({ ...cron, cron: "   " }), "Please provide a cron expression.");
  assert.strictEqual(validateCreateRoutineInput({ ...cron, cron: "0 9 * * *" }), null);
});

test("routines-model: validateCreateRoutineInput rejects negative intervals and defaults empty ones", () => {
  assert.strictEqual(validateCreateRoutineInput({ ...intervalInput, intervalMinutes: -1 }), "Interval must be at least 1 minute.");
  assert.strictEqual(validateCreateRoutineInput({ ...intervalInput, intervalMinutes: 0 }), null);
  assert.strictEqual(normalizeIntervalMinutes(0), 60);
});

test("routines-model: routineStatusBadge maps every status and an unknown one to Idle", () => {
  assert.deepStrictEqual(routineStatusBadge("success"), { label: "✓ Success", tone: "success" });
  assert.deepStrictEqual(routineStatusBadge("error"), { label: "✗ Error", tone: "danger" });
  assert.deepStrictEqual(routineStatusBadge("running"), { label: "⚡ Running", tone: "warning" });
  assert.deepStrictEqual(routineStatusBadge(undefined), { label: "Idle", tone: "neutral" });
});

test("routines-model: routineActionText reads the record prompt and never throws on bad JSON", () => {
  const routine: Routine = {
    routineId: "r1",
    name: "Fallback name",
    recordJson: JSON.stringify({ prompt: "Inspect the build queue", scheduleType: "interval" }),
    triggerDescription: "every 60 minutes",
  };
  assert.strictEqual(routineActionText(routine), "Inspect the build queue");
  assert.strictEqual(routineActionText({ ...routine, recordJson: "{not json" }), "Fallback name");
  assert.strictEqual(routineActionText({ ...routine, recordJson: "{}" }), "Fallback name");
  assert.strictEqual(routineActionText({ ...routine, recordJson: null, name: "" }), "Untitled routine");
});

test("routines-model: formatNextRun reports Disabled when there is no valid time", () => {
  const at = new Date(2030, 0, 2, 9, 5).getTime();
  assert.strictEqual(formatNextRun(at), new Date(at).toLocaleTimeString());
  assert.strictEqual(formatNextRun(undefined), "Disabled");
  assert.strictEqual(formatNextRun(null), "Disabled");
  assert.strictEqual(formatNextRun(Number.NaN), "Disabled");
});

test("routines-model: toggleLabel flips on isEnabled", () => {
  assert.strictEqual(toggleLabel(true), "Pause");
  assert.strictEqual(toggleLabel(false), "Enable");
  assert.strictEqual(toggleLabel(undefined), "Enable");
});

test("routines-model: modal state opens and closes the create dialog", () => {
  const initial = createInitialModalState();
  assert.deepStrictEqual(initial, { createRoutineModalOpen: false });
  const opened = openCreateRoutineModal(initial);
  assert.strictEqual(opened.createRoutineModalOpen, true);
  assert.deepStrictEqual(closeCreateRoutineModal(opened), initial);
});

test("routines-model: empty-state copy matches the legacy controller", () => {
  assert.strictEqual(ROUTINE_EMPTY_STATE, 'No background routines configured. Click "+ New Routine" to schedule one.');
});
