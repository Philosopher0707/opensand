// CI only until hidden-window mode lands (Dex). A local run opens a real Electron window on the
// owner's screen, so this test skips outside CI; GitHub's CI job still runs it.
import { whenElectronExited } from "./helpers/electron-exit.js";
import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withElectronLock } from "./electron-lock.js";
import { hermeticElectronEnv, makeTempHome } from "./hermetic-env.js";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const NAV_HELPER_URL = pathToFileURL(path.join(pkgRoot, "dist/test/helpers/navigate-view.js")).href;

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
import fs from "node:fs";
import path from "node:path";
import { navigateToView } from "${NAV_HELPER_URL}";

const shotDir = process.env.OPENSAND_SETUP_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_SETUP_TIMEOUT_MS || 100000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const setInput = (selector, value) => "(() => { const i = document.querySelector(" + JSON.stringify(selector) + "); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, " + JSON.stringify(value) + "); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()";
const setSelect = (selector, value) => "(() => { const s = document.querySelector(" + JSON.stringify(selector) + "); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, " + JSON.stringify(value) + "); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()";
async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}

const result = { welcomeMessage: "", localDisabled: null, keyInputType: "", keyInitiallyEmpty: null, validationError: "", testSuccess: "", testBodyUsesEnteredKey: null, keyMaskedAfterSave: null, chatAfterSave: null, settingsViaMenu: null, secretInDom: null, version: "", providerVisible: null, accountFields: null, engine: null, sizes: {}, detectReject: null, externalSave: null };

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#viewWelcome') && !document.querySelector('#viewWelcome').classList.contains('hidden') && document.body.classList.contains('is-electron')");
      await wait("document.querySelector('#welcomeOllamaStatus') && !document.querySelector('#welcomeLoading')");
      result.welcomeMessage = await js("document.querySelector('#welcomeOllamaStatus').textContent.trim()");
      result.localDisabled = await js("document.querySelector('#btnUseOllama').disabled");
      await shot("welcome-960x740");

      // The connection test is deterministic; no other fetch is stubbed, so Save really writes.
      await js("(() => { window.__testBody = null; const orig = window.fetch.bind(window); window.fetch = async (input, init) => { const url = String(input && input.url ? input.url : input); if (url.includes('/api/settings/test')) { window.__testBody = JSON.parse((init && init.body) || '{}'); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }); } return orig(input, init); }; return true; })()");

      await js("document.querySelector('#btnWelcomeAddKey').click()");
      await wait("document.querySelector('#welcomeSettingsApiKey') && document.querySelector('#welcomeSettingsApiKey').offsetParent");
      await wait("document.querySelector('#welcomeSettingsEndpoint') && !document.querySelector('#welcomeSettingsEndpoint').disabled");
      result.keyInputType = await js("document.querySelector('#welcomeSettingsApiKey').type");
      result.keyInitiallyEmpty = await js("document.querySelector('#welcomeSettingsApiKey').value === ''");

      // Cancel returns to the two choices; reopening keeps the same form.
      await js("document.querySelector('#welcomeSettingsCancel').click()");
      await wait("document.querySelector('#btnWelcomeAddKey') && !document.querySelector('#welcomeSettingsApiKey')");
      await js("document.querySelector('#btnWelcomeAddKey').click()");
      await wait("document.querySelector('#welcomeSettingsEndpoint') && !document.querySelector('#welcomeSettingsEndpoint').disabled");

      // Empty endpoint is rejected without calling the server.
      await js(setInput("#welcomeSettingsEndpoint", ""));
      await sleep(100);
      await js("document.querySelector('#welcomeSettingsSave').click()");
      await wait("document.querySelector('#welcomeSettingsError')");
      result.validationError = await js("document.querySelector('#welcomeSettingsError').textContent.trim()");

      await js(setInput("#welcomeSettingsEndpoint", "https://api.example.com/v1/chat/completions"));
      await js(setSelect("#welcomeSettingsModel", "test-model"));
      await js(setInput("#welcomeSettingsApiKey", "sk-test-123"));
      await js("document.querySelector('#welcomeSettingsTest').click()");
      await wait("document.querySelector('#welcomeSettingsSuccess') && document.querySelector('#welcomeSettingsSuccess').textContent.includes('successful')");
      result.testSuccess = await js("document.querySelector('#welcomeSettingsSuccess').textContent.trim()");
      result.testBodyUsesEnteredKey = await js("Boolean(window.__testBody && window.__testBody.apiKey && window.__testBody.apiKey !== '********')");

      await js("document.querySelector('#welcomeSettingsSave').click()");
      await wait("document.querySelector('#viewChat') && !document.querySelector('#viewChat').classList.contains('hidden')");
      result.chatAfterSave = await js("String(window.location.hash).includes('#chat')");
      result.keyMaskedAfterSave = await js("document.querySelector('#welcomeSettingsApiKey') ? document.querySelector('#welcomeSettingsApiKey').value === '' : document.querySelector('#settingsApiKey').value === ''");
      result.secretInDom = await js("!document.body.innerText.includes('sk-test-123')");

      // Menu/tray "Settings…" IPC opens the real form rather than a stub card.
      win.webContents.send("opensand:openSettings");
      await wait("document.querySelector('#viewSettings') && !document.querySelector('#viewSettings').classList.contains('hidden')");
      await wait("document.querySelector('#settingsEndpoint') && !document.querySelector('#settingsEndpoint').disabled");
      result.settingsViaMenu = await js("String(window.location.hash).includes('#settings') && document.querySelector('#viewChat').classList.contains('hidden')");
      result.version = await js("document.querySelector('#settingsVersion').textContent.trim()");
      result.providerVisible = await js("Boolean(document.querySelector('#settingsProvider') && document.querySelector('#settingsEndpoint') && document.querySelector('#settingsApiKey') && document.querySelector('#settingsTest'))");

      // The same engine choice as the legacy dialog: every absent binary is disabled with a plain reason.
      await wait("document.querySelector('#settingsEngine')");
      result.engine = await js("(() => { const s = document.querySelector('#settingsEngine'); const h = document.querySelector('#settingsEngineHint'); return { count: s.options.length, value: s.value, disabled: Array.from(s.options).filter((o) => o.disabled).map((o) => o.value), hint: h ? h.textContent.trim() : '' }; })()");

      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(350);
        result.sizes[tag] = await js("(() => { const f = document.querySelector('#viewSettings .settings-form'); const r = f ? f.getBoundingClientRect() : null; const e = document.querySelector('#settingsEngine'); const er = e ? e.getBoundingClientRect() : null; return { visible: Boolean(r && r.width > 0 && r.height > 0), fits: Boolean(r && r.left >= -1 && r.right <= window.innerWidth + 1), noOverflow: document.documentElement.scrollWidth <= window.innerWidth, engineVisible: Boolean(er && er.width > 0 && er.height > 0), engineFits: Boolean(er && er.left >= -1 && er.right <= window.innerWidth + 1) }; })()");
        await shot("settings-" + tag + "-" + width + "x" + height);
      }

      // Render-level contracts: intercept the real form's fetches, not just a helper's result.
      await js("(() => { window.__detectMode = 'reject'; window.__settingsBody = null; window.__testCalls = 0; const orig = window.fetch.bind(window); window.fetch = async (input, init) => { const url = String(input && input.url ? input.url : input); if (url.includes('/api/settings/test')) { window.__testCalls++; return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }); } if (url.includes('/api/engines/detect')) { if (window.__detectMode === 'reject') return Promise.reject(new Error('simulated detection outage ECONNRESET')); return new Response(JSON.stringify([{ engine: 'claude', installed: true, signedIn: true }]), { status: 200, headers: { 'Content-Type': 'application/json' } }); } if (init && String(init.method || '').toUpperCase() === 'POST' && url.endsWith('/api/settings')) { window.__settingsBody = JSON.parse(String(init.body || '{}')); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }); } return orig(input, init); }; return true; })()");
      const reloadSettings = async () => {
        await navigateToView({ js, sleep }, "#chat", "#viewChat");
        await navigateToView({ js, sleep }, "#settings", "#viewSettings");
        await wait("document.querySelector('#settingsEngine') && !document.querySelector('#settingsEngine').disabled");
        await sleep(150);
      };

      // A rejected detector must not take Settings down with it.
      await reloadSettings();
      result.detectReject = await js("(() => { const s = document.querySelector('#settingsEngine'); const e = document.querySelector('#settingsEndpoint'); const h = document.querySelector('#settingsEngineHint'); const f = document.querySelector('#viewSettings .settings-form'); return { value: s.value, enabled: !s.disabled && !e.disabled, visible: Boolean(f && f.getBoundingClientRect().width > 0), hint: h ? h.textContent.trim() : '', rawError: /ECONNRESET|simulated detection outage/.test(document.body.innerText) }; })()");

      // An external engine sends only { engine }: no typed key, no provider fields, no connection test.
      await js("window.__detectMode = 'claude'");
      await reloadSettings();
      await wait("Array.from(document.querySelectorAll('#settingsEngine option')).some(o => o.value === 'claude' && !o.disabled)");
      await js(setSelect('#settingsEngine', 'claude'));
      await sleep(150);
      result.accountFields = await js("({ provider: Boolean(document.querySelector('#settingsProvider')), endpoint: Boolean(document.querySelector('#settingsEndpoint')), apiKey: Boolean(document.querySelector('#settingsApiKey')), test: Boolean(document.querySelector('#settingsTest')), engineModel: Boolean(document.querySelector('#settingsModel')) })");
      await js("document.querySelector('#settingsSave').click()");
      await wait("Boolean(window.__settingsBody)");
      result.externalSave = await js("({ body: window.__settingsBody, testCalls: window.__testCalls })");

      console.log("__SETUP_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[setup runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact welcome → save → chat and Settings menu real-window path (CI only until hidden-window mode lands)", async (t) => {
  if (!process.env.CI && !process.env.OPENSAND_ALLOW_LOCAL_REAL_WINDOW) {
    t.skip("CI only until hidden-window mode lands (Dex): local runs take over the screen");
    return;
  }
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-setup-home-");
  const ws = makeTempHome("opensand-setup-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Setup Test Workspace\n", "utf8");
  const stateDir = path.join(home, ".opensand");
  fs.mkdirSync(stateDir, { recursive: true });
  // A remote endpoint with no key forces /welcome on first run without depending on local Ollama.
  fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "test-model",
    provider: "openai",
    autoApprove: false,
    theme: "dark",
  }), "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-setup-harness-"));
  const runner = path.join(tmpDir, "runner-setup.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");
  const proofDir = process.env.OPENSAND_SETUP_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-setup-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = stateDir;
  env.OPENSAND_SETUP_SHOT_DIR = proofDir;

  let stdout = "";
  let stderr = "";

  try {
    const code = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], {
        cwd: ws,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      return whenElectronExited(child);
    });

    assert.strictEqual(code, 0, `setup runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__SETUP_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.match(res.welcomeMessage, /not detected|no models/i, "welcome reports the local-model probe result");
    assert.strictEqual(res.localDisabled, true, "local Ollama choice is disabled when it is not usable");
    assert.strictEqual(res.keyInputType, "password", "API key input is masked");
    assert.strictEqual(res.keyInitiallyEmpty, true, "a saved key is never rendered into the input");
    assert.match(res.validationError, /endpoint/i, "empty endpoint is rejected with a plain message");
    assert.match(res.testSuccess, /successful/i, "test connection shows success");
    assert.strictEqual(res.testBodyUsesEnteredKey, true, "test sends the entered key, never the mask");
    assert.strictEqual(res.keyMaskedAfterSave, true, "key field is cleared after saving");
    assert.strictEqual(res.chatAfterSave, true, "saving finishes on Chat");
    assert.strictEqual(res.secretInDom, true, "the raw key never appears in the page text");
    assert.strictEqual(res.settingsViaMenu, true, "menu/tray IPC opens the real Settings form");
    assert.match(res.version, /^OpenSand v\d+\.\d+\.\d+/, "Settings footer shows the running package version");
    assert.strictEqual(res.providerVisible, true, "OpenSand shows provider, endpoint, key and connection test");
    assert.deepStrictEqual(res.accountFields, { provider: false, endpoint: false, apiKey: false, test: false, engineModel: true }, "account engines hide provider fields and show the engine model");
    assert.strictEqual(res.engine.count, 7, "Settings offers the default plus six coding agents");
    assert.strictEqual(res.engine.value, "opensand", "an unavailable engine falls back to the default");
    if (res.engine.disabled.length) assert.match(res.engine.hint, /^Not installed: .+\.$/);
    else assert.strictEqual(res.engine.hint, "");
    assert.strictEqual(res.engine.disabled.includes("opensand"), false, "the default engine is never disabled");
    assert.doesNotMatch(res.engine.hint, /npm|CLI|--|is not installed on this computer/);

    for (const [tag] of [["compact"], ["wide"]] as const) {
      const size = res.sizes[tag];
      assert.ok(size, `${tag} metrics present`);
      assert.strictEqual(size.visible, true, `${tag}: settings form visible`);
      assert.strictEqual(size.fits, true, `${tag}: settings form fits the viewport`);
      assert.strictEqual(size.noOverflow, true, `${tag}: no horizontal overflow`);
      assert.strictEqual(size.engineVisible, true, `${tag}: engine select visible`);
      assert.strictEqual(size.engineFits, true, `${tag}: engine select fits the viewport`);
    }

    assert.strictEqual(res.detectReject.value, "opensand", "a rejected detector keeps OpenSand selected");
    assert.strictEqual(res.detectReject.enabled, true, "Settings stays enabled when detection fails");
    assert.strictEqual(res.detectReject.visible, true, "Settings form stays visible when detection fails");
    assert.match(res.detectReject.hint, /Engine status is unavailable/i, "detection failure shows the plain hint");
    assert.strictEqual(res.detectReject.rawError, false, "no raw network error reaches the page");
    assert.deepStrictEqual(res.externalSave.body, { engine: "claude" }, "external engine save sends only { engine }");
    assert.strictEqual(res.externalSave.testCalls, 0, "external engine save never tests the typed key");
    console.log("[proof] welcome/settings real-window screenshots:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
