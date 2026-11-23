import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { withElectronLock } from "./electron-lock.js";
import { hermeticElectronEnv, makeTempHome } from "./hermetic-env.js";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function skipReason(): string | undefined {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY";
  }
  if (!fs.existsSync(path.join(pkgRoot, "node_modules", ".bin", "electron"))) return "Electron binary not found";
  if (!fs.existsSync(path.join(pkgRoot, "dist", "renderer-next", "index.html"))) return "dist/renderer-next is not built";
  return undefined;
}

const RUNNER_SCRIPT = String.raw`
import { app } from "electron";
const TIMEOUT_MS = Number(process.env.OPENSAND_DEAD_ACTIONS_TIMEOUT_MS || 45000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code);
const wait = async (fn) => { for (let i = 0; i < 120; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.body.classList.contains('is-electron') && document.querySelector('#viewSettings')");

      // Row 3: the main-process tray/menu IPC must land on the settings view now.
      w.webContents.send("opensand:openSettings");
      await wait("String(window.location.hash) === '#settings'");
      const settingsVisible = await js("!document.querySelector('#viewSettings').classList.contains('hidden')");

      // Row 6 failure path: the Inspector events must be listened to, not throw, with no session selected.
      const errors = [];
      w.webContents.on("console-message", (_e, level, message) => { if (level === 2) errors.push(message); });
      await js("window.dispatchEvent(new CustomEvent('opensand:open_rollback'))");
      await js("window.dispatchEvent(new CustomEvent('opensand:open_compact'))");
      await sleep(300);
      const hashAfterEvents = await js("window.location.hash");
      const retryWithoutUserMessage = await js("Boolean(document.querySelector('.chat-retry'))");

      console.log("__DEAD_ACTIONS_RESULT__:" + JSON.stringify({ settingsVisible, errors, hashAfterEvents, retryWithoutUserMessage }));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[dead-actions runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Dead actions: Settings IPC navigates the real Preact renderer to #settings", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-dead-actions-home-");
  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-dead-actions-harness-"));
  const runner = path.join(tmpDir, "runner-dead-actions.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");

  let stdout = "";
  let stderr = "";
  try {
    const code = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], {
        cwd: home,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      return new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 0)));
    });
    assert.strictEqual(code, 0, `Electron runner failed.\nstdout: ${stdout}\nstderr: ${stderr}`);
    const line = stdout.split("\n").find((l) => l.startsWith("__DEAD_ACTIONS_RESULT__:"));
    assert.ok(line, `no result line in stdout:\n${stdout}\nstderr: ${stderr}`);
    const result = JSON.parse(line!.slice("__DEAD_ACTIONS_RESULT__:".length));
    assert.strictEqual(result.settingsVisible, true, "settings panel is visible after the Settings IPC");
    assert.strictEqual(result.hashAfterEvents, "#settings", "Inspector events do not navigate away");
    assert.deepStrictEqual(result.errors, [], "no console errors while the Inspector events fire without a session");
    assert.strictEqual(result.retryWithoutUserMessage, false, "Retry stays hidden with no previous user message");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
