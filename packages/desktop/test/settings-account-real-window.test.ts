import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { whenElectronExited } from "./helpers/electron-exit.js";
import { withElectronLock } from "./electron-lock.js";
import { hermeticElectronEnv, makeTempHome } from "./hermetic-env.js";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const require = createRequire(import.meta.url);
const shotDir = process.env.OPENSAND_ACCOUNT_SHOT_DIR || "";

const RUNNER = String.raw`
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const shotDir = process.env.OPENSAND_ACCOUNT_SHOT_DIR || "";
const timeout = setTimeout(() => { console.error("account settings runner timeout"); app.quit(); process.exit(1); }, 90000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code);
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const setSelect = (selector, value) => "(() => { const s = document.querySelector(" + JSON.stringify(selector) + "); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, " + JSON.stringify(value) + "); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()";
const forceSelect = (selector, value) => "(() => { const s = document.querySelector(" + JSON.stringify(selector) + "); const o = Array.from(s.options).find((x) => x.value === " + JSON.stringify(value) + "); if (o) o.disabled = false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, " + JSON.stringify(value) + "); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()";
async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}

const result = { version: "", openSandVisible: false, accountHidden: false, hint: "", claudeHint: "", openCodeModels: 0, openCodeSelected: "", openCodeHint: "" };
app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#btnSettings') && document.querySelector('#settingEngine')");
      await js("document.querySelector('#btnSettings').click()");
      await wait("document.querySelector('#settingsModal') && !document.querySelector('#settingsModal').classList.contains('hidden') && !document.querySelector('#settingEngine').disabled");
      await wait("document.querySelector('#settingsVersion') && document.querySelector('#settingsVersion').textContent.trim() !== '…'");
      result.version = await js("document.querySelector('#settingsVersion').textContent.trim()");
      result.hint = await js("document.querySelector('#engineHint').textContent.trim()");
      result.openSandVisible = await js("!document.querySelector('#settingProviderGroup').hidden && !document.querySelector('#settingEndpointGroup').hidden && !document.querySelector('#settingModelGroup').hidden && !document.querySelector('#settingApiKeyGroup').hidden");
      await shot("legacy-opensand-settings");

      await js(forceSelect("#settingEngine", "claude"));
      await wait("!document.querySelector('#settingEngineModelGroup').hidden");
      result.accountHidden = await js("document.querySelector('#settingProviderGroup').hidden && document.querySelector('#settingEndpointGroup').hidden && document.querySelector('#settingModelGroup').hidden && document.querySelector('#settingApiKeyGroup').hidden");
      result.claudeHint = await js("document.querySelector('#engineModelHint').textContent.trim()");
      await shot("legacy-claude-account-settings");

      await js(forceSelect("#settingEngine", "opencode"));
      await sleep(250);
      await js("(() => { const s = document.querySelector('#settingEngineModel'); if (s.options.length > 1) { s.value = s.options[1].value; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()");
      result.openCodeModels = await js("document.querySelector('#settingEngineModel').options.length");
      result.openCodeSelected = await js("document.querySelector('#settingEngineModel').value");
      result.openCodeHint = await js("document.querySelector('#engineModelHint').textContent.trim()");
      if (result.openCodeModels > 1) await js("document.querySelector('#settingEngineModel').size = Math.min(6, document.querySelector('#settingEngineModel').options.length)");
      await shot("legacy-opencode-fallback-models");
      await js("document.querySelector('#settingEngineModel').size = 1");

      console.log("__ACCOUNT_SETTINGS_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error(err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("legacy Settings hides provider fields for account engines and shows the real version", async (t) => {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    t.skip("Electron real-window test requires a display on Linux");
    return;
  }
  if (!process.env.CI && !process.env.OPENSAND_ALLOW_LOCAL_REAL_WINDOW) {
    t.skip("local real-window proof is opt-in");
    return;
  }
  if (!fs.existsSync(path.join(pkgRoot, "node_modules", ".bin", "electron"))) {
    t.skip("Electron binary not found");
    return;
  }
  if (!fs.existsSync(path.join(pkgRoot, "dist", "src", "main.js"))) {
    t.skip("desktop main is not built");
    return;
  }

  const home = makeTempHome("opensand-account-home-");
  const ws = makeTempHome("opensand-account-ws-");
  const stateDir = path.join(home, ".opensand");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# Account settings proof\n");
  fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    endpoint: "https://api.example.test/v1/chat/completions",
    model: "gpt-5.4",
    provider: "openai",
    apiKey: "FAKE_KEY_FOR_RENDER_TEST_0000",
    autoApprove: false,
    theme: "dark",
  }));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-account-harness-"));
  const runner = path.join(tmpDir, "runner-account.mjs");
  fs.writeFileSync(runner, RUNNER);
  const proofDir = shotDir || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-account-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
  const env = hermeticElectronEnv(home);
  delete env.OPENSAND_RENDERER;
  const fakeBinDir = path.join(tmpDir, "bin");
  fs.mkdirSync(fakeBinDir, { recursive: true });
  env.PATH = fakeBinDir;
  assert.equal(env.HOME, home, "Electron test uses its isolated temporary HOME");
  assert.equal(env.USERPROFILE, home, "Electron test uses its isolated temporary USERPROFILE");
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = stateDir;
  env.OPENSAND_ACCOUNT_SHOT_DIR = proofDir;
  env.OPENSAND_EXPECTED_VERSION = pkg.version;
  const electronExecutable = require("electron") as string;

  let stdout = "";
  let stderr = "";
  try {
    const code = await withElectronLock(async () => {
      const child = spawn(electronExecutable, [`--user-data-dir=${tmpDir}`, runner], {
        cwd: ws,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      return whenElectronExited(child);
    });
    assert.equal(code, 0, `account settings runner failed\n${stdout}\n${stderr}`);
    const match = stdout.match(/__ACCOUNT_SETTINGS_RESULT__:(.*)/);
    assert.ok(match, `missing result\n${stdout}\n${stderr}`);
    const result = JSON.parse(match[1]);
    assert.equal(result.version, `OpenSand v${pkg.version}`);
    assert.equal(result.openSandVisible, true);
    assert.equal(result.accountHidden, true);
    assert.ok(result.hint === "" || /^Not installed: /.test(result.hint), "missing-engine hint is either empty or one collapsed line");
    console.log("[proof] legacy account settings screenshots:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("account real-window test cannot resolve the real HOME or CLI credentials", () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const forbidden = [
    ["OPENSAND", "ACCOUNT", "REQUIRE", "LIVE"].join("_"),
    ["process", "env", "HOME"].join("."),
    ["os", "homedir"].join("."),
    ["/usr", "bin", "which"].join("/"),
    ["opencode", "live", "models"].join("-"),
  ];
  for (const value of forbidden) assert.equal(source.includes(value), false, `source contains forbidden live mode: ${value}`);
});
