import test from "node:test";
import assert from "node:assert";
import {
  SENTINEL_FEED_EMPTY_STATE,
  SENTINEL_VALIDATION_MESSAGE,
  SENTINEL_WATCHERS_EMPTY_STATE,
  closeCreateWatcherModal,
  createInitialModalState,
  openCreateWatcherModal,
  parseDebounce,
  sentinelLogView,
  validateCreateWatcherInput,
  watcherCardView,
  type CreateWatcherInput,
} from "../src/shell/sentinel-model.js";

const valid: CreateWatcherInput = {
  targetDir: "/tmp/project",
  checkCommand: "pnpm test",
  autoHeal: true,
  debounceMs: 500,
};

test("sentinel-model: validation requires a target directory", () => {
  assert.strictEqual(validateCreateWatcherInput(valid), null);
  assert.strictEqual(validateCreateWatcherInput({ ...valid, targetDir: "" }), SENTINEL_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateWatcherInput({ ...valid, targetDir: "   " }), SENTINEL_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateWatcherInput({ ...valid, targetDir: " /tmp/x " }), null);
});

test("sentinel-model: debounce matches the legacy parseInt default", () => {
  assert.strictEqual(parseDebounce("750"), 750);
  assert.strictEqual(parseDebounce(""), 500);
  assert.strictEqual(parseDebounce("abc"), 500);
});

test("sentinel-model: watcher card applies badges and defaults", () => {
  assert.deepStrictEqual(watcherCardView({ id: "w-1", targetDir: "/a" }), {
    title: "w-1",
    statusLabel: "Passive",
    statusClass: "badge",
    target: "/a",
    checkLabel: "Filesystem Only",
    debounceLabel: "500ms",
  });
  assert.deepStrictEqual(watcherCardView({ ...valid, id: "w-2" } as any), {
    title: "w-2",
    statusLabel: "Auto-Heal Active",
    statusClass: "badge badge-success",
    target: "/tmp/project",
    checkLabel: "pnpm test",
    debounceLabel: "500ms",
  });
});

test("sentinel-model: log view normalises status, trigger and proposal", () => {
  const view = sentinelLogView({
    status: "healed",
    triggerFile: "src/main.ts",
    timestampMs: 0,
    targetDir: "/a",
    checkCommand: "pnpm test",
    output: "FAIL",
    healingProposal: "revert commit",
  });
  assert.strictEqual(view.className, "sentinel-item healed");
  assert.strictEqual(view.statusClass, "status-badge healed");
  assert.strictEqual(view.status, "healed");
  assert.strictEqual(view.trigger, "src/main.ts");
  assert.strictEqual(view.target, "/a");
  assert.strictEqual(view.command, "pnpm test");
  assert.strictEqual(view.output, "FAIL");
  assert.strictEqual(view.healingProposal, "revert commit");

  const fallback = sentinelLogView({ timestampMs: 1000 });
  assert.strictEqual(fallback.status, "clean");
  assert.strictEqual(fallback.trigger, "change");
  assert.strictEqual(fallback.command, "N/A");
  assert.strictEqual(fallback.output, "");
  assert.strictEqual(fallback.healingProposal, "");
});

test("sentinel-model: modal open/close helpers and empty states", () => {
  const initial = createInitialModalState();
  assert.deepStrictEqual(initial, { createWatcherModalOpen: false });
  const opened = openCreateWatcherModal(initial);
  assert.deepStrictEqual(opened, { createWatcherModalOpen: true });
  assert.deepStrictEqual(closeCreateWatcherModal(opened), initial);
  assert.ok(SENTINEL_WATCHERS_EMPTY_STATE.includes('+ New Watcher'));
  assert.ok(SENTINEL_FEED_EMPTY_STATE.includes('No diagnostic events'));
});
