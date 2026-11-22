import test from "node:test";
import assert from "node:assert";
import {
  SIDEBAR_KEY,
  THEME_KEY,
  classifyShortcut,
  nextSidebarCollapsed,
  persistSidebarCollapsed,
  persistTheme,
  readSidebarCollapsed,
  readTheme,
  resolveEscapeTarget,
  resolveSidebarCollapsed,
  resolveTheme,
  toggleTheme,
  type ShellStorage,
} from "../src/shell/account-model.js";

function fakeStorage(seed: Record<string, string> = {}): ShellStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

test("account-model: theme falls back to the OS preference only when storage has no valid value", () => {
  assert.strictEqual(resolveTheme("dark", false), "dark");
  assert.strictEqual(resolveTheme("light", true), "light");
  assert.strictEqual(resolveTheme(null, true), "dark");
  assert.strictEqual(resolveTheme(null, false), "light");
  assert.strictEqual(resolveTheme("sepia", false), "light", "unknown stored value is ignored");
  assert.strictEqual(resolveTheme("", true), "dark");
});

test("account-model: toggling theme always flips between the two valid values", () => {
  assert.strictEqual(toggleTheme("dark"), "light");
  assert.strictEqual(toggleTheme("light"), "dark");
  assert.strictEqual(toggleTheme(toggleTheme("dark")), "dark");
});

test("account-model: only the literal string 'true' collapses the sidebar", () => {
  assert.strictEqual(resolveSidebarCollapsed("true"), true);
  assert.strictEqual(resolveSidebarCollapsed("false"), false);
  assert.strictEqual(resolveSidebarCollapsed(null), false);
  assert.strictEqual(resolveSidebarCollapsed("TRUE"), false);
});

test("account-model: nextSidebarCollapsed honours an explicit force value, including false", () => {
  assert.strictEqual(nextSidebarCollapsed(false), true);
  assert.strictEqual(nextSidebarCollapsed(true), false);
  assert.strictEqual(nextSidebarCollapsed(false, true), true);
  assert.strictEqual(nextSidebarCollapsed(true, true), true);
  assert.strictEqual(nextSidebarCollapsed(true, false), false, "explicit false is not a missing argument");
  assert.strictEqual(nextSidebarCollapsed(false, false), false);
});

test("account-model: reads and writes the legacy localStorage keys", () => {
  const storage = fakeStorage({ [THEME_KEY]: "light", [SIDEBAR_KEY]: "true" });
  assert.strictEqual(readTheme(storage, true), "light");
  assert.strictEqual(readSidebarCollapsed(storage), true);

  persistTheme(storage, "dark");
  persistSidebarCollapsed(storage, false);
  assert.deepStrictEqual(storage.data, { [THEME_KEY]: "dark", [SIDEBAR_KEY]: "false" });
});

test("account-model: storage errors degrade to defaults instead of throwing", () => {
  const broken: ShellStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.strictEqual(readTheme(broken, false), "light");
  assert.strictEqual(readSidebarCollapsed(broken), false);
  assert.doesNotThrow(() => persistTheme(broken, "dark"));
  assert.doesNotThrow(() => persistSidebarCollapsed(broken, true));
  assert.strictEqual(readTheme(null, true), "dark");
});

test("account-model: shortcuts map Cmd/Ctrl keys and ignore bare keys", () => {
  assert.strictEqual(classifyShortcut({ key: "b", metaKey: true }), "toggle-sidebar");
  assert.strictEqual(classifyShortcut({ key: "B", ctrlKey: true }), "toggle-sidebar");
  assert.strictEqual(classifyShortcut({ key: "i", metaKey: true }), "toggle-detail");
  assert.strictEqual(classifyShortcut({ key: "I", ctrlKey: true }), "toggle-detail");
  assert.strictEqual(classifyShortcut({ key: "a", metaKey: true, shiftKey: true }), "toggle-canvas");
  assert.strictEqual(classifyShortcut({ key: "A", ctrlKey: true, shiftKey: true }), "toggle-canvas");
  assert.strictEqual(classifyShortcut({ key: "Escape" }), "escape");
  assert.strictEqual(classifyShortcut({ key: "Esc" }), "escape");

  assert.strictEqual(classifyShortcut({ key: "b" }), null, "bare B types into the composer");
  assert.strictEqual(classifyShortcut({ key: "a", metaKey: true }), null, "Cmd+A stays select-all");
  assert.strictEqual(classifyShortcut({ key: "b", metaKey: true, shiftKey: true }), null);
  assert.strictEqual(classifyShortcut({ key: "Enter", metaKey: true }), null);
});

test("account-model: Esc closes layers in topmost-first order", () => {
  const base = { accountPopupOpen: false, canvasOpen: false, isFullscreen: false, detailOpen: false, turnBusy: false };
  assert.strictEqual(resolveEscapeTarget(base), "none");
  assert.strictEqual(resolveEscapeTarget({ ...base, turnBusy: true }), "cancel-turn");
  assert.strictEqual(resolveEscapeTarget({ ...base, detailOpen: true, turnBusy: true }), "detail");
  assert.strictEqual(resolveEscapeTarget({ ...base, canvasOpen: true, detailOpen: true, turnBusy: true }), "canvas");
  assert.strictEqual(resolveEscapeTarget({ ...base, canvasOpen: true, isFullscreen: true }), "exit-fullscreen");
  assert.strictEqual(
    resolveEscapeTarget({ ...base, accountPopupOpen: true, canvasOpen: true, detailOpen: true, turnBusy: true }),
    "account-popup",
    "the account popup is the topmost layer",
  );
});
