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

const shotDir = process.env.OPENSAND_CONNECTORS_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_CONNECTORS_TIMEOUT_MS || 90000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 250; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const nativeSet = (sel, proto, value, eventName) => "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); Object.getOwnPropertyDescriptor(" + proto + ".prototype, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event(" + JSON.stringify(eventName) + ", { bubbles: true })); return true; })()";
const setInput = (sel, value) => nativeSet(sel, "HTMLInputElement", value, "input");

async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => { const done = () => r(true); requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 2000); })");
  await sleep(250);
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}

const measure = () => js("(() => {\n" +
  "const panel = document.querySelector('#viewConnectors');\n" +
  "const grid = document.querySelector('#connectorsCardGrid') ? document.querySelector('#connectorsCardGrid').getBoundingClientRect() : null;\n" +
  "const card = document.querySelector('#connectorsCardGrid .connector-dashboard-card') ? document.querySelector('#connectorsCardGrid .connector-dashboard-card').getBoundingClientRect() : null;\n" +
  "const create = document.querySelector('#configureConnectorModal');\n" +
  "const createOpen = create && !create.classList.contains('hidden');\n" +
  "const cc = createOpen && create.querySelector('.modal-card') ? create.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "const fits = (r) => r ? (r.left >= -1 && r.right <= window.innerWidth + 1) : false;\n" +
  "return {\n" +
    "scrollWidth: document.documentElement.scrollWidth,\n" +
    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
    "panelVisible: panel ? !panel.classList.contains('hidden') : false,\n" +
    "gridFits: fits(grid), cardFits: fits(card),\n" +
    "createOpen: Boolean(createOpen),\n" +
    "createCardFits: cc ? (fits(cc) && cc.top >= -1 && cc.bottom <= window.innerHeight + 1) : false,\n" +
  "};\n" +
"})()");

const DUMMY_CONNECTOR_INPUT = "placeholder";
const result = { empty: null, cards: null, validation: null, hint: null, tokenLeaked: null, configured: null, oauthOpened: null, oauthConnected: null, tested: null, disconnected: null, escClosed: null, sizes: { grid: {}, create: {} } };

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#connectorsCardGrid') && document.body.classList.contains('is-electron')");
      await navigateToView({ js, sleep }, "#connectors", "#viewConnectors");
      await wait("document.querySelector('#connectorsCardGrid .connectors-empty') || document.querySelector('#connectorsCardGrid .connector-dashboard-card')");

      await js("window.__testConnectors = []");
      await js("document.querySelector('#btnRefreshConnectors').click()");
      await wait("document.querySelector('#connectorsCardGrid .connectors-empty')");
      result.empty = await js("document.querySelector('#connectorsCardGrid .connectors-empty').textContent.trim()");
      await shot("connectors-empty-960x740");

      await js("(() => {\n" +
        "const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } });\n" +
        "window.__connectors = [\n" +
          " { id: 'slack', name: 'Slack', description: 'Team chat', status: 'disconnected', icon: '💬', brandColor: '#4A154B', scopes: ['chat:read'] },\n" +
          " { id: 'github', name: 'GitHub', description: 'Source control', status: 'connected', account: 'octocat', connectedAt: 0, scopes: ['repo'] },\n" +
          " { id: 'linear', name: 'Linear', description: 'Issue tracking', status: 'disconnected', scopes: ['issues:read'] }\n" +
        "];\n" +
        "window.__opened = null;\n" +
        "window.open = (url) => { window.__opened = url; return null; };\n" +
        "window.confirm = () => true;\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "const method = (init && init.method) || 'GET';\n" +
          "const parts = url.split('/').filter(Boolean);\n" +
          "const id = decodeURIComponent(parts[parts.length - 2] || '');\n" +
          "if (!url.includes('/api/connectors')) return orig(input, init);\n" +
          "if (method === 'GET' && parts.length === 2) return json(window.__connectors);\n" +
          "if (method === 'GET') { const c = window.__connectors.find((x) => x.id === id); return json(c || {}); }\n" +
          "if (url.includes('/disconnect')) { const c = window.__connectors.find((x) => x.id === id); if (c) c.status = 'disconnected'; return json({ ok: true }); }\n" +
          "if (url.includes('/test')) return json({ ok: true, message: 'Connection verified!' });\n" +
          "if (url.includes('/connect')) {\n" +
            "const body = JSON.parse((init && init.body) || '{}');\n" +
            "if (body.token && !body.token.trim()) return json({ error: 'Please enter a token or API key.' }, 400);\n" +
            "const c = window.__connectors.find((x) => x.id === id);\n" +
            "if (c) { c.status = 'connected'; if (body.account) c.account = body.account; }\n" +
            "return json(body.token ? { ok: true } : { authUrl: 'https://example.test/oauth' });\n" +
          "}\n" +
          "return json([]);\n" +
        "};\n" +
      "return true;\n" +
    "})()");
      await js("(() => { window.__testConnectors = window.__connectors; window.opensand.disconnectApp = async (id) => { const c = window.__connectors.find((x) => x.id === id); if (c) c.status = 'disconnected'; return { ok: true }; }; return true; })()");
      await js("document.querySelector('#btnRefreshConnectors').click()");
      await wait("document.querySelectorAll('#connectorsCardGrid .connector-dashboard-card').length === 3");
      result.cards = await js("Array.from(document.querySelectorAll('#connectorsCardGrid .connect-card-title')).map((e) => e.textContent.trim())");
      await shot("connectors-grid-960x740");

      // Configure modal: reset, provider hint, required-token validation.
      await js("document.querySelector('#connectorsCardGrid .btn-dash-config-token').click()");
      await wait("!document.querySelector('#configureConnectorModal').classList.contains('hidden')");
      result.hint = await js("document.querySelector('#configureConnectorHint').textContent.trim()");
      await js("document.querySelector('#btnSaveConnectorConfig').click()");
      await wait("document.querySelector('#connectorFormError').textContent.includes('Please enter a token')");
      result.validation = await js("document.querySelector('#connectorFormError').textContent.trim()");
      await shot("connectors-validation-960x740");

      await js(setInput('#configureConnectorAccount', 'my-workspace'));
      await js(setInput('#configureConnectorToken', '" + DUMMY_CONNECTOR_INPUT + "'));
      await js("document.querySelector('#btnSaveConnectorConfig').click()");
      await wait("document.querySelector('#configureConnectorModal').classList.contains('hidden')");
      await wait("document.querySelectorAll('#connectorsCardGrid .badge-connected').length === 2");
      result.configured = await js("({ account: document.querySelector('#connectorsCardGrid .connector-account').textContent.trim(), statuses: Array.from(document.querySelectorAll('#connectorsCardGrid .connect-card-badge')).map((e) => e.textContent.trim()) })");
      result.tokenLeaked = await js("document.body.textContent.includes('" + DUMMY_CONNECTOR_INPUT + "')");

      // OAuth flow on the still-disconnected Linear connector.
      await js("document.querySelector('#connectorsCardGrid .btn-dash-oauth').click()");
      await wait("Boolean(window.__opened)");
      result.oauthOpened = await js("window.__opened");
      await wait("document.querySelectorAll('#connectorsCardGrid .badge-connected').length === 3");
      result.oauthConnected = await js("Array.from(document.querySelectorAll('#connectorsCardGrid .connect-card-badge')).map((e) => e.textContent.trim())");

      // Test connection shows an inline result, then disconnect confirms.
      await js("document.querySelector('#connectorsCardGrid .btn-dash-test').click()");
      await wait("Boolean(document.querySelector('#connectorsCardGrid') && document.querySelector('.connectors-notice'))");
      result.tested = await js("document.querySelector('.connectors-notice').textContent.trim()");
      await shot("connectors-connected-960x740");

      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.grid[tag] = await measure();
        await shot("connectors-grid-" + tag + "-" + width + "x" + height);
      }

      await js("document.querySelector('#connectorsCardGrid .btn-dash-config-token').click()");
      await wait("!document.querySelector('#configureConnectorModal').classList.contains('hidden')");
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.create[tag] = await measure();
        await shot("connectors-create-" + tag + "-" + width + "x" + height);
      }
      await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await wait("document.querySelector('#configureConnectorModal').classList.contains('hidden')");
      result.escClosed = true;

      await js("document.querySelector('#connectorsCardGrid .btn-dash-disconnect').click()");
      await wait("document.querySelectorAll('#connectorsCardGrid .badge-connected').length === 2");
      result.disconnected = await js("document.querySelectorAll('#connectorsCardGrid .badge-connected').length");

      console.log("__CONNECTORS_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[connectors runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact connectors view, token/OAuth flows, test and disconnect at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const home = makeTempHome("opensand-connectors-home-");
  const ws = makeTempHome("opensand-connectors-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Connectors Real Window Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-connectors-harness-"));
  const runner = path.join(tmpDir, "runner-connectors.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");
  const proofDir = process.env.OPENSAND_CONNECTORS_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-connectors-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_CONNECTORS_SHOT_DIR = proofDir;

  let stdout = "";
  let stderr = "";
  try {
    const code = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      return new Promise<number>((resolve) => {
        let done = false;
        let watchdog: NodeJS.Timeout;
        const settle = (code: number) => { if (done) return; done = true; clearTimeout(watchdog); resolve(code); };
        watchdog = setTimeout(() => { child.kill("SIGKILL"); settle(124); }, 180_000);
        void whenElectronExited(child).then(settle);
        child.on("error", (err) => { stderr += String(err); settle(1); });
      });
    });
    assert.strictEqual(code, 0, `connectors runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__CONNECTORS_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.ok(res.empty.includes("No connectors"), `empty state renders (${res.empty})`);
    assert.deepStrictEqual(res.cards, ["Slack", "GitHub", "Linear"], "all connector cards render");
    assert.ok(res.hint.includes("xoxb-"), `provider hint renders (${res.hint})`);
    assert.strictEqual(res.validation, "Please enter a token or API key.", "empty token is rejected inline");
    assert.ok(res.configured.account.includes("my-workspace"), "saved account renders");
    assert.deepStrictEqual(res.configured.statuses, ["Connected", "Connected", "Disconnected"], "token connect marks the connector connected");
    assert.strictEqual(res.tokenLeaked, false, "the token canary is never rendered after saving");
    assert.strictEqual(res.oauthOpened, "https://example.test/oauth", "OAuth flow opens the provider URL");
    assert.deepStrictEqual(res.oauthConnected, ["Connected", "Connected", "Connected"], "bounded polling picks up the connected status");
    assert.strictEqual(res.tested, "Connection verified!", "test result renders inline");
    assert.strictEqual(res.escClosed, true, "Esc closes the configure modal");
    assert.strictEqual(res.disconnected, 2, "disconnect removes the connected badge");

    for (const tag of ["compact", "wide"]) {
      for (const group of [res.sizes.grid, res.sizes.create]) {
        const m = group[tag];
        assert.strictEqual(m.panelVisible, true, `${tag} panel visible`);
        assert.strictEqual(m.noOverflow, true, `${tag} has no horizontal overflow`);
        assert.strictEqual(m.gridFits, true, `${tag} grid fits`);
      }
      assert.strictEqual(res.sizes.create[tag].createOpen, true, `${tag} configure modal open`);
      assert.strictEqual(res.sizes.create[tag].createCardFits, true, `${tag} configure modal card fits`);
    }
    console.log("connectors real-window: empty/validation/token/OAuth/test/disconnect states and 960x740 + 1920x1080 zero-overflow checks passed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(proofDir, { recursive: true, force: true });
  }
});
