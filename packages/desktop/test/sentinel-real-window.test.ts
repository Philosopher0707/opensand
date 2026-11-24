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

const shotDir = process.env.OPENSAND_SENTINEL_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_SENTINEL_TIMEOUT_MS || 90000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
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
  "const panel = document.querySelector('#viewSentinel');\n" +
  "const grid = document.querySelector('#sentinelWatchersGrid') ? document.querySelector('#sentinelWatchersGrid').getBoundingClientRect() : null;\n" +
  "const feed = document.querySelector('#sentinelFeed') ? document.querySelector('#sentinelFeed').getBoundingClientRect() : null;\n" +
  "const card = document.querySelector('#sentinelWatchersGrid .dashboard-card') ? document.querySelector('#sentinelWatchersGrid .dashboard-card').getBoundingClientRect() : null;\n" +
  "const item = document.querySelector('#sentinelFeed .sentinel-item') ? document.querySelector('#sentinelFeed .sentinel-item').getBoundingClientRect() : null;\n" +
  "const create = document.querySelector('#createWatcherModal');\n" +
  "const createOpen = create && !create.classList.contains('hidden');\n" +
  "const cc = createOpen && create.querySelector('.modal-card') ? create.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "const fits = (r) => r ? (r.left >= -1 && r.right <= window.innerWidth + 1) : false;\n" +
  "return {\n" +
    "innerWidth: window.innerWidth,\n" +
    "scrollWidth: document.documentElement.scrollWidth,\n" +
    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
    "panelVisible: panel ? !panel.classList.contains('hidden') : false,\n" +
    "gridFits: fits(grid),\n" +
    "feedFits: fits(feed),\n" +
    "cardFits: fits(card),\n" +
    "itemFits: fits(item),\n" +
    "createOpen: Boolean(createOpen),\n" +
    "createCardFits: cc ? (fits(cc) && cc.top >= -1 && cc.bottom <= window.innerHeight + 1) : false,\n" +
  "};\n" +
"})()");

const LONG_PATH = "/Users/me/dev/" + "very-long-workspace-directory-name/".repeat(12);
const result = { emptyWatchers: null, emptyFeed: null, resetFields: null, validation: null, created: null, feedEntry: null, stopCount: null, escClosed: null, sizes: { grid: {}, feed: {}, create: {} } };

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#sentinelWatchersGrid') && document.body.classList.contains('is-electron')");
      await navigateToView({ js, sleep }, "#sentinel", "#viewSentinel");
      await wait("!document.querySelector('#sentinelWatchersGrid .sentinel-loading')");

      result.emptyWatchers = await js("document.querySelector('#sentinelWatchersGrid .sentinel-empty') ? document.querySelector('#sentinelWatchersGrid .sentinel-empty').textContent.trim() : ''");
      result.emptyFeed = await js("document.querySelector('#sentinelFeed .sentinel-empty') ? document.querySelector('#sentinelFeed .sentinel-empty').textContent.trim() : ''");
      await shot("sentinel-empty-960x740");

      await js("(() => {\n" +
        "const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } });\n" +
        "window.__watchers = [];\n" +
        "window.__logs = [{ status: 'healed', triggerFile: 'src/main.ts', timestampMs: 1700000000000, targetDir: '/a', checkCommand: 'pnpm test', output: '" + "FAIL ".repeat(60) + "', healingProposal: '" + "revert ".repeat(60) + "' }];\n" +
        "window.confirm = () => true;\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "const method = (init && init.method) || 'GET';\n" +
          "if (url.includes('/api/sentinels/logs')) return json(window.__logs);\n" +
          "if (url.includes('/api/sentinels')) {\n" +
            "if (method === 'GET') return json(window.__watchers);\n" +
            "if (method === 'POST') {\n" +
              "const body = JSON.parse((init && init.body) || '{}');\n" +
              "if (!body.targetDir || !body.targetDir.trim()) return json({ error: 'Please specify target directory to watch.' }, 400);\n" +
              "const w = { id: 'watcher_' + (window.__watchers.length + 1), targetDir: body.targetDir, checkCommand: body.checkCommand, autoHeal: body.autoHeal, debounceMs: body.debounceMs };\n" +
              "window.__watchers = [...window.__watchers, w];\n" +
              "return json(w, 201);\n" +
            "}\n" +
            "if (method === 'DELETE') {\n" +
              "const id = decodeURIComponent(url.split('/').slice(-1)[0]);\n" +
              "window.__watchers = window.__watchers.filter((w) => w.id !== id);\n" +
              "return json({ success: true });\n" +
            "}\n" +
          "}\n" +
          "return orig(input, init);\n" +
        "};\n" +
      "return true;\n" +
    "})()");

      // Modal: reset fields, inline validation.
      await js("document.querySelector('#btnOpenCreateWatcher').click()");
      await wait("!document.querySelector('#createWatcherModal').classList.contains('hidden')");
      result.resetFields = await js("({ targetDir: document.querySelector('#watcherTargetDir').value, checkCommand: document.querySelector('#watcherCheckCommand').value, autoHeal: document.querySelector('#watcherAutoHeal').checked, debounce: document.querySelector('#watcherDebounce').value })");
      await js("document.querySelector('#btnSaveWatcher').click()");
      await wait("document.querySelector('#watcherFormError').textContent.includes('Please specify target directory')");
      result.validation = await js("document.querySelector('#watcherFormError').textContent.trim()");
      await shot("sentinel-validation-960x740");

      await js(setInput('#watcherTargetDir', LONG_PATH));
      await js(setInput('#watcherCheckCommand', 'pnpm test'));
      await js(setInput('#watcherDebounce', '750'));
      await js("document.querySelector('#btnSaveWatcher').click()");
      await wait("document.querySelectorAll('#sentinelWatchersGrid .dashboard-card').length === 1");
      await wait("document.querySelector('#createWatcherModal').classList.contains('hidden')");
      result.created = await js("({ title: document.querySelector('#sentinelWatchersGrid .card-title').textContent.trim(), badges: Array.from(document.querySelectorAll('#sentinelWatchersGrid .card-meta .badge')).map((b) => b.textContent.trim()) })");
      await shot("sentinel-card-created-960x740");

      // Feed with long single-line output and proposal must stay inside the panel.
      result.feedEntry = await js("({ status: document.querySelector('#sentinelFeed .status-badge') ? document.querySelector('#sentinelFeed .status-badge').textContent.trim() : '', trigger: document.querySelector('#sentinelFeed .sentinel-trigger') ? document.querySelector('#sentinelFeed .sentinel-trigger').textContent.trim() : '', hasProposal: Boolean(document.querySelector('#sentinelFeed .sentinel-proposal-box')) })");

      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.grid[tag] = await measure();
        result.sizes.feed[tag] = await measure();
        await shot("sentinel-grid-" + tag + "-" + width + "x" + height);
      }

      await js("document.querySelector('#btnOpenCreateWatcher').click()");
      await wait("!document.querySelector('#createWatcherModal').classList.contains('hidden')");
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.create[tag] = await measure();
        await shot("sentinel-create-" + tag + "-" + width + "x" + height);
      }
      await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await wait("document.querySelector('#createWatcherModal').classList.contains('hidden')");
      result.escClosed = true;

      await js("document.querySelector('#sentinelWatchersGrid .btn-stop-watcher').click()");
      await wait("document.querySelectorAll('#sentinelWatchersGrid .dashboard-card').length === 0");
      result.stopCount = await js("document.querySelectorAll('#sentinelWatchersGrid .dashboard-card').length");

      console.log("__SENTINEL_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[sentinel runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact sentinel view, creation, feed and stop at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-sentinel-home-");
  const ws = makeTempHome("opensand-sentinel-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Sentinel Real Window Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-sentinel-harness-"));
  const runner = path.join(tmpDir, "runner-sentinel.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const proofDir = process.env.OPENSAND_SENTINEL_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-sentinel-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_SENTINEL_SHOT_DIR = proofDir;

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
      return new Promise<number>((resolve) => {
        let done = false;
        let watchdog: NodeJS.Timeout;
        const settle = (code: number) => {
          if (done) return;
          done = true;
          clearTimeout(watchdog);
          resolve(code);
        };
        watchdog = setTimeout(() => { child.kill("SIGKILL"); settle(124); }, 180_000);
        void whenElectronExited(child).then(settle);
        child.on("error", (err) => { stderr += String(err); settle(1); });
      });
    });

    assert.strictEqual(code, 0, `sentinel runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__SENTINEL_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.ok(res.emptyWatchers.includes("No active workspace watchers"), `empty watchers state renders (${res.emptyWatchers})`);
    assert.ok(res.emptyFeed.includes("No diagnostic events"), `empty feed state renders (${res.emptyFeed})`);
    assert.deepStrictEqual(res.resetFields, { targetDir: "", checkCommand: "", autoHeal: true, debounce: "500" }, "modal opens with reset fields");
    assert.strictEqual(res.validation, "Please specify target directory to watch.", "empty target is rejected inline");
    assert.ok(res.created.title.includes("watcher_1"), `created card shows the watcher id (${res.created.title})`);
    assert.deepStrictEqual(res.created.badges, ["Check: pnpm test", "Debounce: 750ms"], "created card shows check and debounce badges");
    assert.strictEqual(res.feedEntry.status, "healed", "feed shows the event status");
    assert.ok(res.feedEntry.trigger.includes("src/main.ts"), "feed shows the trigger file");
    assert.strictEqual(res.feedEntry.hasProposal, true, "feed shows the healing proposal");
    assert.strictEqual(res.escClosed, true, "Esc closes the create modal");
    assert.strictEqual(res.stopCount, 0, "stop removes the watcher card");

    for (const [size, group] of [["compact", res.sizes.grid], ["compact", res.sizes.feed], ["wide", res.sizes.grid], ["wide", res.sizes.feed]]) {
      assert.strictEqual(group[size].panelVisible, true, `${size} panel visible`);
      assert.strictEqual(group[size].noOverflow, true, `${size} has no horizontal overflow`);
      assert.strictEqual(group[size].gridFits, true, `${size} watcher grid fits`);
      assert.strictEqual(group[size].feedFits, true, `${size} feed fits`);
    }
    for (const size of ["compact", "wide"]) {
      const m = res.sizes.create[size];
      assert.strictEqual(m.createOpen, true, `${size} create modal open`);
      assert.strictEqual(m.noOverflow, true, `${size} create modal has no horizontal overflow`);
      assert.strictEqual(m.createCardFits, true, `${size} create modal card fits`);
    }
    console.log("sentinel real-window: empty/validation/create/feed/stop states and 960x740 + 1920x1080 zero-overflow checks passed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(proofDir, { recursive: true, force: true });
  }
});
