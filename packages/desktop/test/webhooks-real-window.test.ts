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

const shotDir = process.env.OPENSAND_WEBHOOKS_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_WEBHOOKS_TIMEOUT_MS || 90000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const nativeSet = (sel, proto, value, eventName) => "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); Object.getOwnPropertyDescriptor(" + proto + ".prototype, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event(" + JSON.stringify(eventName) + ", { bubbles: true })); return true; })()";
const setInput = (sel, value) => nativeSet(sel, "HTMLInputElement", value, "input");
const setSelect = (sel, value) => "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()";

async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => { const done = () => r(true); requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 2000); })");
  await sleep(250);
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}

const measure = () => js("(() => {\n" +
  "const panel = document.querySelector('#viewWebhooks');\n" +
  "const grid = document.querySelector('#webhooksCardGrid') ? document.querySelector('#webhooksCardGrid').getBoundingClientRect() : null;\n" +
  "const feed = document.querySelector('#webhooksDeliveriesFeed') ? document.querySelector('#webhooksDeliveriesFeed').getBoundingClientRect() : null;\n" +
  "const card = document.querySelector('#webhooksCardGrid .dashboard-card') ? document.querySelector('#webhooksCardGrid .dashboard-card').getBoundingClientRect() : null;\n" +
  "const item = document.querySelector('#webhooksDeliveriesFeed .webhook-item') ? document.querySelector('#webhooksDeliveriesFeed .webhook-item').getBoundingClientRect() : null;\n" +
  "const create = document.querySelector('#createWebhookModal');\n" +
  "const createOpen = create && !create.classList.contains('hidden');\n" +
  "const cc = createOpen && create.querySelector('.modal-card') ? create.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "const fits = (r) => r ? (r.left >= -1 && r.right <= window.innerWidth + 1) : false;\n" +
  "return {\n" +
    "scrollWidth: document.documentElement.scrollWidth,\n" +
    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
    "panelVisible: panel ? !panel.classList.contains('hidden') : false,\n" +
    "gridFits: fits(grid), feedFits: fits(feed), cardFits: fits(card), itemFits: fits(item),\n" +
    "createOpen: Boolean(createOpen),\n" +
    "createCardFits: cc ? (fits(cc) && cc.top >= -1 && cc.bottom <= window.innerHeight + 1) : false,\n" +
  "};\n" +
"})()");

const SECRET = "whsec_super_secret_canary_12345";
const LONG_RESULT = "queued ".repeat(80);
const result = { emptyHooks: null, emptyFeed: null, resetFields: null, validation: null, created: null, secretLeaked: null, copied: null, deliveries: null, remaining: null, escClosed: null, sizes: { grid: {}, feed: {}, create: {} } };

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.body.classList.contains('is-electron')");
      await navigateToView({ js, sleep }, "#webhooks", "#viewWebhooks");
      await wait("document.querySelector('#webhooksCardGrid')");
      await wait("document.querySelector('#webhooksCardGrid .webhooks-empty') || document.querySelector('#webhooksCardGrid .dashboard-card')");

      await js("window.__testWebhooks = []; window.__testWebhookDeliveries = []");
      await js("document.querySelector('#btnRefreshWebhooks').click()");
      await wait("document.querySelector('#webhooksCardGrid .webhooks-empty')");
      result.emptyHooks = await js("document.querySelector('#webhooksCardGrid .webhooks-empty').textContent.trim()");
      result.emptyFeed = await js("document.querySelector('#webhooksDeliveriesFeed .webhooks-empty') ? document.querySelector('#webhooksDeliveriesFeed .webhooks-empty').textContent.trim() : ''");
      await shot("webhooks-empty-960x740");

      await js("(() => {\n" +
        "const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } });\n" +
        "window.__hooks = [];\n" +
        "window.__deliveries = [\n" +
          " { status: 'success', webhookName: 'nightly', durationMs: 12, result: '" + LONG_RESULT + "', timestamp: 1700000000000 },\n" +
          " { status: 'failed', webhookName: 'nightly', error: 'bad signature', timestamp: 1700000000001 }\n" +
        "];\n" +
        "window.__copied = null;\n" +
        "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } });\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "const method = (init && init.method) || 'GET';\n" +
          "if (!url.includes('/api/webhooks')) return orig(input, init);\n" +
          "if (url.includes('/api/webhooks/deliveries')) return json(window.__deliveries);\n" +
          "if (method === 'GET') return json(window.__hooks);\n" +
          "if (method === 'POST') {\n" +
            "const body = JSON.parse((init && init.body) || '{}');\n" +
            "if (!body.name || !body.name.trim() || !body.targetId || !body.targetId.trim()) return json({ error: 'Please specify webhook slug name and target ID.' }, 400);\n" +
            "const hook = { name: body.name, targetType: body.targetType, targetId: body.targetId, hasSecret: Boolean(body.secret), filterEvent: body.filterEvent, triggerCount: 0 };\n" +
            "window.__hooks.push(hook);\n" +
            "return json(hook, 201);\n" +
          "}\n" +
          "if (method === 'DELETE') {\n" +
            "const name = decodeURIComponent(url.split('/').slice(-1)[0]);\n" +
            "const i = window.__hooks.findIndex((h) => h.name === name);\n" +
            "if (i >= 0) window.__hooks.splice(i, 1);\n" +
            "return json({ success: true });\n" +
          "}\n" +
          "return json([]);\n" +
        "};\n" +
      "return true;\n" +
    "})()");
      await js("(() => { window.__testWebhooks = window.__hooks; window.__testWebhookDeliveries = window.__deliveries; window.confirm = () => true; return true; })()");
      await js("document.querySelector('#btnRefreshWebhooks').click()");
      await wait("document.querySelectorAll('#webhooksDeliveriesFeed .webhook-item').length === 2");

      await js("document.querySelector('#btnOpenCreateWebhook').click()");
      await wait("!document.querySelector('#createWebhookModal').classList.contains('hidden')");
      result.resetFields = await js("({ name: document.querySelector('#webhookName').value, targetType: document.querySelector('#webhookTargetType').value, targetId: document.querySelector('#webhookTargetId').value, secret: document.querySelector('#webhookSecret').value, filterEvent: document.querySelector('#webhookFilterEvent').value })");
      await js("document.querySelector('#btnSaveWebhook').click()");
      await wait("document.querySelector('#webhookFormError').textContent.includes('Please specify webhook slug name')");
      result.validation = await js("document.querySelector('#webhookFormError').textContent.trim()");
      await shot("webhooks-validation-960x740");

      await js(setInput('#webhookName', 'nightly'));
      await js(setSelect('#webhookTargetType', 'routine'));
      await js(setInput('#webhookTargetId', 'r-123'));
      await js(setInput('#webhookSecret', '" + SECRET + "'));
      await js(setInput('#webhookFilterEvent', 'push'));
      await js("document.querySelector('#btnSaveWebhook').click()");
      await wait("document.querySelectorAll('#webhooksCardGrid .dashboard-card').length === 1");
      await wait("document.querySelector('#createWebhookModal').classList.contains('hidden')");
      result.created = await js("({ title: document.querySelector('#webhooksCardGrid .card-title').textContent.trim(), target: document.querySelector('#webhooksCardGrid .card-desc').textContent.trim(), badges: Array.from(document.querySelectorAll('#webhooksCardGrid .card-meta .badge')).map((b) => b.textContent.trim()), url: document.querySelector('#webhooksCardGrid .webhook-url-box').textContent.trim() })");
      result.secretLeaked = await js("document.body.textContent.includes('" + SECRET + "')");

      await js("document.querySelector('#webhooksCardGrid .btn-copy-curl').click()");
      await wait("Boolean(window.__copied)");
      result.copied = await js("window.__copied");
      await shot("webhooks-deliveries-960x740");

      result.deliveries = await js("({ statuses: Array.from(document.querySelectorAll('#webhooksDeliveriesFeed .status-badge')).map((e) => e.textContent.trim()), errors: Array.from(document.querySelectorAll('#webhooksDeliveriesFeed .webhook-error-text')).map((e) => e.textContent.trim()) })");

      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.grid[tag] = await measure();
        result.sizes.feed[tag] = await measure();
        await shot("webhooks-feed-" + tag + "-" + width + "x" + height);
      }

      await js("document.querySelector('#btnOpenCreateWebhook').click()");
      await wait("!document.querySelector('#createWebhookModal').classList.contains('hidden')");
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.create[tag] = await measure();
        await shot("webhooks-create-" + tag + "-" + width + "x" + height);
      }
      await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await wait("document.querySelector('#createWebhookModal').classList.contains('hidden')");
      result.escClosed = true;

      await js("document.querySelector('#webhooksCardGrid .btn-delete-webhook').click()");
      await wait("document.querySelectorAll('#webhooksCardGrid .dashboard-card').length === 0");
      result.remaining = await js("document.querySelectorAll('#webhooksCardGrid .dashboard-card').length");

      console.log("__WEBHOOKS_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[webhooks runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact webhooks view, creation, secret masking, deliveries and deletion at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const home = makeTempHome("opensand-webhooks-home-");
  const ws = makeTempHome("opensand-webhooks-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Webhooks Real Window Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-webhooks-harness-"));
  const runner = path.join(tmpDir, "runner-webhooks.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");
  const proofDir = process.env.OPENSAND_WEBHOOKS_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-webhooks-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_WEBHOOKS_SHOT_DIR = proofDir;

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
    assert.strictEqual(code, 0, `webhooks runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__WEBHOOKS_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.ok(res.emptyHooks.includes("No inbound webhooks"), `empty grid renders (${res.emptyHooks})`);
    assert.ok(res.emptyFeed.includes("No webhook deliveries"), `empty feed renders (${res.emptyFeed})`);
    assert.deepStrictEqual(res.resetFields, { name: "", targetType: "routine", targetId: "", secret: "", filterEvent: "" }, "modal opens with reset fields");
    assert.strictEqual(res.validation, "Please specify webhook slug name and target ID.", "empty fields are rejected inline");
    assert.ok(res.created.title.includes("nightly"), `created card shows the slug (${res.created.title})`);
    assert.ok(res.created.target.includes("ROUTINE"));
    assert.deepStrictEqual(res.created.badges, ["Auth: HMAC-SHA256", "Event: push"], "created card shows auth and event badges");
    assert.ok(res.created.url.includes("/api/webhooks/nightly"), "created card shows the webhook URL");
    assert.strictEqual(res.secretLeaked, false, "the signing secret is never rendered after creation");
    assert.ok(res.copied.includes('"event":"trigger"'), "Copy curl writes a usable command");
    assert.deepStrictEqual(res.deliveries.statuses, ["FAILED", "SUCCESS"], "deliveries render newest first");
    assert.deepStrictEqual(res.deliveries.errors, ["Error: bad signature"], "delivery errors render");
    assert.strictEqual(res.escClosed, true, "Esc closes the create modal");
    assert.strictEqual(res.remaining, 0, "delete removes the webhook card");

    for (const tag of ["compact", "wide"]) {
      for (const group of [res.sizes.grid, res.sizes.feed, res.sizes.create]) {
        const m = group[tag];
        assert.strictEqual(m.panelVisible, true, `${tag} panel visible`);
        assert.strictEqual(m.noOverflow, true, `${tag} has no horizontal overflow`);
        assert.strictEqual(m.gridFits, true, `${tag} grid fits`);
        assert.strictEqual(m.feedFits, true, `${tag} delivery feed fits`);
      }
      assert.strictEqual(res.sizes.create[tag].createOpen, true, `${tag} create modal open`);
      assert.strictEqual(res.sizes.create[tag].createCardFits, true, `${tag} create modal card fits`);
    }
    console.log("webhooks real-window: empty/validation/create/secret-mask/deliveries/delete states and 960x740 + 1920x1080 zero-overflow checks passed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(proofDir, { recursive: true, force: true });
  }
});
