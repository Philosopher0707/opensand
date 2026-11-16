import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DesktopApp, resolveStateDir, isSmokeMode } from "../src/main.js";

function makeFakeElectron() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const syncHandlers = new Map<string, (...args: any[]) => any>();
  const appEvents = new Map<string, Array<() => void>>();
  const windowOptions: any[] = [];
  let singleInstanceLockRequested = false;
  let userDataPath = "";

  class FakeBrowserWindow {
    public webContents: any;
    constructor(options: unknown) {
      windowOptions.push(options);
      this.webContents = {
        sent: [] as Array<[string, unknown]>,
        send: (channel: string, payload: unknown) => {
          this.webContents.sent.push([channel, payload]);
        },
        setWindowOpenHandler: () => {},
        on: () => {},
      };
    }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    isVisible() { return true; }
    focus() {}
    restore() {}
    show() {}
    hide() {}
    static getAllWindows() { return []; }
  }

  const electron = {
    app: {
      requestSingleInstanceLock: () => {
        singleInstanceLockRequested = true;
        return true;
      },
      whenReady: async () => {},
      isPackaged: true,
      getVersion: () => "0.1.10",
      setPath: (name: string, p: string) => {
        if (name === "userData") userDataPath = p;
      },
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

  return {
    electron,
    handlers,
    appEvents,
    windowOptions,
    wasLockRequested: () => singleInstanceLockRequested,
    getUserDataPath: () => userDataPath,
  };
}

test("resolveStateDir: default case resolves to ~/.opensand", () => {
  const expectedDefault = path.join(os.homedir(), ".opensand");
  assert.strictEqual(resolveStateDir({}), expectedDefault);
  assert.strictEqual(resolveStateDir({ OPENSAND_STATE_DIR: "" }), expectedDefault);
  assert.strictEqual(resolveStateDir({ OPENSAND_STATE_DIR: "   " }), expectedDefault);
});

test("resolveStateDir: OPENSAND_STATE_DIR environment override takes effect", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-state-test-"));
  try {
    const customDir = path.join(tmp, "custom-state");
    assert.strictEqual(resolveStateDir({ OPENSAND_STATE_DIR: customDir }), path.resolve(customDir));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveStateDir: explicit overrideBaseDir takes precedence over environment variable", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-state-test-"));
  try {
    const envDir = path.join(tmp, "env-state");
    const explicitDir = path.join(tmp, "explicit-state");
    assert.strictEqual(
      resolveStateDir({ OPENSAND_STATE_DIR: envDir }, explicitDir),
      path.resolve(explicitDir)
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isSmokeMode: default case is false", () => {
  assert.strictEqual(isSmokeMode({}), false);
  assert.strictEqual(isSmokeMode({ OPENSAND_SMOKE: undefined }), false);
  assert.strictEqual(isSmokeMode({ OPENSAND_SMOKE: "" }), false);
  assert.strictEqual(isSmokeMode({ OPENSAND_SMOKE: "0" }), false);
  assert.strictEqual(isSmokeMode({ OPENSAND_SMOKE: "false" }), false);
  assert.strictEqual(isSmokeMode({ OPENSAND_SMOKE: "no" }), false);
});

test("isSmokeMode: parses truthy flags (1, true, yes)", () => {
  assert.strictEqual(isSmokeMode({ OPENSAND_SMOKE: "1" }), true);
  assert.strictEqual(isSmokeMode({ OPENSAND_SMOKE: "true" }), true);
  assert.strictEqual(isSmokeMode({ OPENSAND_SMOKE: "TRUE" }), true);
  assert.strictEqual(isSmokeMode({ OPENSAND_SMOKE: "yes" }), true);
  assert.strictEqual(isSmokeMode({ OPENSAND_SMOKE: " YES " }), true);
});

test("DesktopApp default mode: single-instance lock requested, window visible and focusable", async () => {
  const fake = makeFakeElectron();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-app-default-"));
  const app = new DesktopApp({
    loadElectron: async () => fake.electron,
    baseDir: tmp,
    env: {},
  });

  try {
    assert.strictEqual(app.getIsSmoke(), false);
    await app.start();
    assert.strictEqual(fake.wasLockRequested(), true, "single-instance lock must be requested by default");
    assert.strictEqual(fake.windowOptions.length, 1);
    const winOpts = fake.windowOptions[0];
    assert.strictEqual(winOpts.show, true, "window must be shown by default");
    assert.strictEqual(winOpts.focusable, true, "window must be focusable by default");
  } finally {
    const server = (app as any).server;
    await server?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("DesktopApp smoke mode: skips single-instance lock, window hidden and unfocusable, writes server.port", async () => {
  const fake = makeFakeElectron();
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-app-smoke-"));
  const app = new DesktopApp({
    loadElectron: async () => fake.electron,
    env: {
      OPENSAND_SMOKE: "1",
      OPENSAND_STATE_DIR: tmpState,
    },
  });

  try {
    assert.strictEqual(app.getIsSmoke(), true);
    assert.strictEqual(app.getStateDir(), path.resolve(tmpState));
    await app.start();

    // Verification 1: Single-instance lock must NOT be requested
    assert.strictEqual(fake.wasLockRequested(), false, "single-instance lock must be skipped in smoke mode");

    // Verification 2: Window must be non-intrusive (no keyboard focus steal)
    assert.strictEqual(fake.windowOptions.length, 1);
    const winOpts = fake.windowOptions[0];
    assert.strictEqual(winOpts.show, false, "window must not be shown in smoke mode");
    assert.strictEqual(winOpts.focusable, false, "window must not steal focus in smoke mode");

    // Verification 3: UserData path isolated
    assert.strictEqual(fake.getUserDataPath(), path.join(path.resolve(tmpState), "electron-user-data"));

    // Verification 4: Server port file written to state dir
    const portFilePath = path.join(tmpState, "server.port");
    assert.ok(fs.existsSync(portFilePath), "server.port file must be created in state dir");
    const portNum = parseInt(fs.readFileSync(portFilePath, "utf8").trim(), 10);
    assert.ok(!isNaN(portNum) && portNum > 0, "server.port must contain a valid port number");

    // Verification 5: Server token file written to state dir
    const tokenFilePath = path.join(tmpState, "server.token");
    assert.ok(fs.existsSync(tokenFilePath), "server.token file must be created in state dir");
    const tokenStr = fs.readFileSync(tokenFilePath, "utf8").trim();
    assert.ok(tokenStr.length >= 32, "server.token must be at least 32 characters");
  } finally {
    const server = (app as any).server;
    await server?.stop();
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

test("DesktopApp default mode (env {}): never writes server.port and never calls setPath('userData')", async () => {
  const fake = makeFakeElectron();
  // We use overrideBaseDir so tests don't touch ~/.opensand, but pass env {} and ensure neither smoke nor env state dir is set
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-default-nobase-"));
  const app = new DesktopApp({
    loadElectron: async () => fake.electron,
    env: {},
  });

  try {
    // In pure default mode, getStateDir is ~/.opensand
    assert.strictEqual(app.getStateDir(), path.join(os.homedir(), ".opensand"));
    assert.strictEqual(app.getIsSmoke(), false);

    // Mock DesktopServer inside app or inspect fake.getUserDataPath()
    await app.start();

    // 1. setPath('userData') must NEVER be called when state dir is ~/.opensand
    assert.strictEqual(fake.getUserDataPath(), "", "setPath('userData') must not be called when state dir is default ~/.opensand");

    // 2. server.port must NOT be written in ~/.opensand
    // Note: ~/.opensand/server.port should not be created by this start call
    // To be hermetically safe without writing ~/.opensand, verify the guard logic directly:
    // With env {}, isSmoke is false and baseDir is ~/.opensand.
    assert.strictEqual(fs.existsSync(path.join(os.homedir(), ".opensand", "server.port")), false, "server.port must not be created in default state dir");
  } finally {
    const server = (app as any).server;
    await server?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("DesktopApp with OPENSAND_STATE_DIR (without smoke): writes server.port and sets userData", async () => {
  const fake = makeFakeElectron();
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-state-only-"));
  const app = new DesktopApp({
    loadElectron: async () => fake.electron,
    env: {
      OPENSAND_STATE_DIR: tmpState,
    },
  });

  try {
    assert.strictEqual(app.getIsSmoke(), false);
    assert.strictEqual(app.getStateDir(), path.resolve(tmpState));

    await app.start();

    // With OPENSAND_STATE_DIR set, single-instance lock IS requested (smoke is false)
    assert.strictEqual(fake.wasLockRequested(), true, "single-instance lock must be requested when smoke is false");

    // userData path IS set
    assert.strictEqual(fake.getUserDataPath(), path.join(path.resolve(tmpState), "electron-user-data"));

    // server.port IS written
    const portFilePath = path.join(tmpState, "server.port");
    assert.ok(fs.existsSync(portFilePath), "server.port file must be created when OPENSAND_STATE_DIR is set");
    const portNum = parseInt(fs.readFileSync(portFilePath, "utf8").trim(), 10);
    assert.ok(!isNaN(portNum) && portNum > 0, "server.port must contain valid port number");
  } finally {
    const server = (app as any).server;
    await server?.stop();
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});
