import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DesktopApp } from "../src/main.js";

/**
 * Regression for the installed v0.1.6 bug: DesktopApp built a second
 * DesktopIpcBridge, so a query sent from the window asked its trust question on
 * an engine nobody could see while the app server's engine stayed idle.
 * These tests drive the real start()/IPC wiring with a fake electron module.
 */

interface FakeWindow {
  webContents: { send: (channel: string, payload: unknown) => void; sent: Array<[string, unknown]>; setWindowOpenHandler: () => void; on: () => void };
  loadURL: () => Promise<void>;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  isVisible: () => boolean;
  focus: () => void;
  restore: () => void;
  show: () => void;
  hide: () => void;
}

function makeFakeElectron() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const syncHandlers = new Map<string, (...args: any[]) => any>();
  const appEvents = new Map<string, Array<() => void>>();
  const windows: FakeWindow[] = [];

  class FakeBrowserWindow {
    public webContents: FakeWindow["webContents"];
    constructor(_options: unknown) {
      const sent: Array<[string, unknown]> = [];
      this.webContents = {
        sent,
        send: (channel: string, payload: unknown) => sent.push([channel, payload]),
        setWindowOpenHandler: () => {},
        on: () => {},
      };
      windows.push(this as unknown as FakeWindow);
    }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    isVisible() { return true; }
    focus() {}
    restore() {}
    show() {}
    hide() {}
    static getAllWindows() { return windows; }
  }

  const electron = {
    app: {
      requestSingleInstanceLock: () => true,
      whenReady: async () => {},
      isPackaged: true,
      getVersion: () => "0.0.0-test",
      on: (name: string, cb: () => void) => {
        const list = appEvents.get(name) || [];
        list.push(cb);
        appEvents.set(name, list);
      },
      quit: () => {},
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: (channel: string, cb: (...args: any[]) => any) => handlers.set(channel, cb),
      on: (channel: string, cb: (...args: any[]) => any) => syncHandlers.set(channel, cb),
    },
    dialog: { showErrorBox: () => {} },
    shell: { openExternal: async () => {} },
  };

  return { electron, handlers, appEvents, windows };
}

async function startApp() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-single-bridge-"));
  const baseDir = path.join(home, ".opensand");
  // Both bridges resolve their state from os.homedir(); keep them off the owner's data.
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  const fake = makeFakeElectron();
  const desktopApp = new DesktopApp({
    loadElectron: async () => fake.electron,
    baseDir,
  });
  await desktopApp.start();
  process.env.HOME = priorHome;
  return { desktopApp, fake, home };
}

test("window IPC handlers drive the same engine as the app server", async () => {
  const { desktopApp, fake, home } = await startApp();
  const server = (desktopApp as any).server;
  try {
    assert.equal((desktopApp as any).bridge, server.getBridge(), "DesktopApp must not build a second engine");

    // Behavioural check: the handler the window actually calls must reach that engine.
    const sentinel = [{ approvalId: "probe", toolName: "folder.trust", args: {}, timestamp: 1 }];
    const realList = server.getBridge().listPendingApprovals.bind(server.getBridge());
    server.getBridge().listPendingApprovals = async () => sentinel as any;
    try {
      const handler = fake.handlers.get("opensand:listPendingApprovals");
      assert.ok(handler, "opensand:listPendingApprovals must be registered");
      assert.deepEqual(await handler!({}), sentinel);
    } finally {
      server.getBridge().listPendingApprovals = realList;
    }
  } finally {
    await server?.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the approval queue sits inside the chat column, above the composer", () => {
  // It used to be a body-level child after the 100vh app shell, so a real card
  // rendered at y=740 in a 740px window: present in the DOM, invisible to the owner.
  const html = fs.readFileSync(new URL("../../renderer/index.html", import.meta.url), "utf8");
  const chatColumn = html.indexOf('<div class="chat-main-column"');
  const queue = html.indexOf('id="approvalQueue"');
  const composer = html.indexOf('<footer class="input-panel">');
  assert.ok(chatColumn >= 0 && queue >= 0 && composer >= 0, "expected chat column, approval queue and composer in the renderer");
  assert.ok(chatColumn < queue && queue < composer, "the approval queue must render between the message feed and the composer");
});

test("opening the window twice registers the bridge event forwarder once", async () => {
  const { desktopApp, fake, home } = await startApp();
  const server = (desktopApp as any).server;
  try {
    const bridge = (desktopApp as any).bridge;
    const baseline = bridge.listenerCount("event");
    const BrowserWindow = fake.electron.BrowserWindow;
    (desktopApp as any).createMainWindow(BrowserWindow, "http://127.0.0.1:1/");
    assert.equal(bridge.listenerCount("event"), baseline, "reopening a window must not add another bridge listener");

    // The forwarder must reach the current window, not the one that was just replaced.
    bridge.emit("event", { type: "turn_complete" });
    const latest = fake.windows[fake.windows.length - 1];
    const delivered = latest.webContents.sent.some(([channel]) => channel === "opensand:event");
    assert.ok(delivered, "bridge events must reach the live window");
  } finally {
    await server?.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
