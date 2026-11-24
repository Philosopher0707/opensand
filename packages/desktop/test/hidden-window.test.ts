import { closeThenRemove } from './teardown.js';
import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DesktopApp, isHiddenWindowMode } from "../src/main.js";
import { hermeticElectronEnv } from "./hermetic-env.js";

test("isHiddenWindowMode: only truthy flags enable hidden mode", () => {
  assert.strictEqual(isHiddenWindowMode({}), false);
  assert.strictEqual(isHiddenWindowMode({ OPENSAND_HIDDEN_WINDOW: undefined }), false);
  assert.strictEqual(isHiddenWindowMode({ OPENSAND_HIDDEN_WINDOW: "" }), false);
  assert.strictEqual(isHiddenWindowMode({ OPENSAND_HIDDEN_WINDOW: "0" }), false);
  assert.strictEqual(isHiddenWindowMode({ OPENSAND_HIDDEN_WINDOW: "false" }), false);
  assert.strictEqual(isHiddenWindowMode({ OPENSAND_HIDDEN_WINDOW: "no" }), false);
  assert.strictEqual(isHiddenWindowMode({ OPENSAND_HIDDEN_WINDOW: "1" }), true);
  assert.strictEqual(isHiddenWindowMode({ OPENSAND_HIDDEN_WINDOW: "true" }), true);
  assert.strictEqual(isHiddenWindowMode({ OPENSAND_HIDDEN_WINDOW: " YES " }), true);
});

test("hermeticElectronEnv: every test launch gets the hidden-window flag", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-hidden-env-"));
  try {
    const env = hermeticElectronEnv(home, { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", KEEP_ME: "yes" });
    assert.strictEqual(env.OPENSAND_HIDDEN_WINDOW, "1");
    assert.strictEqual(env.HOME, home);
    assert.strictEqual(env.USERPROFILE, home);
    assert.strictEqual(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.strictEqual(env.KEEP_ME, "yes");
  } finally {
    await closeThenRemove([], home);
  }
});

function makeFakeElectron() {
  const appEvents = new Map<string, Array<() => void>>();
  const windowOptions: any[] = [];
  const calls = { show: 0, focus: 0, moveTop: 0, activatePolicy: [] as string[], dockHide: 0 };
  let dockIconSet = 0;

  class FakeBrowserWindow {
    public webContents: any;
    constructor(options: unknown) {
      windowOptions.push(options);
      this.webContents = {
        send: () => {},
        setWindowOpenHandler: () => {},
        on: () => {},
      };
    }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    isVisible() { return false; }
    show() { calls.show++; }
    focus() { calls.focus++; }
    moveTop() { calls.moveTop++; }
    hide() {}
    restore() {}
    static getAllWindows() { return []; }
  }

  const electron = {
    app: {
      requestSingleInstanceLock: () => true,
      whenReady: async () => {},
      isPackaged: false,
      getVersion: () => "0.1.14",
      setPath: () => {},
      setActivationPolicy: (policy: string) => { calls.activatePolicy.push(policy); },
      dock: {
        hide: () => { calls.dockHide++; },
        setIcon: () => { dockIconSet++; },
      },
      on: (name: string, cb: () => void) => {
        const list = appEvents.get(name) || [];
        list.push(cb);
        appEvents.set(name, list);
      },
      quit: () => {},
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { handle: () => {}, on: () => {} },
    dialog: { showErrorBox: () => {} },
    shell: { openExternal: async () => {} },
  };
  return { electron, appEvents, windowOptions, calls, dockIconCount: () => dockIconSet };
}

test("DesktopApp hidden mode: no visible window, Dock icon, tray or focus steal", async () => {
  const fake = makeFakeElectron();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-hidden-app-"));
  const app = new DesktopApp({
    loadElectron: async () => fake.electron,
    env: { OPENSAND_HIDDEN_WINDOW: "1", OPENSAND_STATE_DIR: stateDir },
  });

  try {
    await app.start();

    assert.ok(fake.windowOptions.length >= 1, "a window must still be created for rendering/IPC");
    for (const opts of fake.windowOptions) {
      assert.strictEqual(opts.show, false, "window must be created hidden");
      assert.strictEqual(opts.focusable, false, "window must not be focusable");
    }
    assert.strictEqual((app as any).trayManager, null, "hidden mode must not create a tray icon");
    assert.strictEqual(fake.dockIconCount(), 0, "hidden mode must not set a Dock icon");

    // Fire the app events that would normally reveal/focus the window.
    for (const cb of fake.appEvents.get("second-instance") || []) cb();
    for (const cb of fake.appEvents.get("activate") || []) cb();

    assert.strictEqual(fake.calls.show, 0, "show() must never be called");
    assert.strictEqual(fake.calls.focus, 0, "focus() must never be called");
    assert.strictEqual(fake.calls.moveTop, 0, "moveTop() must never be called");
    assert.ok(
      fake.windowOptions.every((o) => o.show === false),
      "a window recreated on activate must also be hidden",
    );

    if (process.platform === "darwin") {
      assert.deepStrictEqual(fake.calls.activatePolicy, ["accessory"]);
      assert.strictEqual(fake.calls.dockHide, 1);
    }
  } finally {
    await closeThenRemove([(app as any).server], stateDir);
  }
});

test("DesktopApp normal mode keeps the visible, focusable window", async () => {
  const fake = makeFakeElectron();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-visible-app-"));
  const app = new DesktopApp({
    loadElectron: async () => fake.electron,
    env: { OPENSAND_STATE_DIR: stateDir },
  });

  try {
    await app.start();
    assert.strictEqual(fake.windowOptions.length, 1);
    assert.strictEqual(fake.windowOptions[0].show, true);
    assert.strictEqual(fake.windowOptions[0].focusable, true);
    assert.deepStrictEqual(fake.calls.activatePolicy, [], "normal launches must not change activation policy");
  } finally {
    await closeThenRemove([(app as any).server], stateDir);
  }
});
