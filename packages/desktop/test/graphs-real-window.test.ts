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

const shotDir = process.env.OPENSAND_GRAPHS_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_GRAPHS_TIMEOUT_MS || 90000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };

async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => { const done = () => r(true); requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 2000); })");
  await sleep(250);
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}

const measure = () => js("(() => {\n" +
  "const panel = document.querySelector('#viewGraphs');\n" +
  "const grid = document.querySelector('#graphsCardGrid') ? document.querySelector('#graphsCardGrid').getBoundingClientRect() : null;\n" +
  "const feed = document.querySelector('#graphTraceFeed') ? document.querySelector('#graphTraceFeed').getBoundingClientRect() : null;\n" +
  "const card = document.querySelector('#graphsCardGrid .dashboard-card') ? document.querySelector('#graphsCardGrid .dashboard-card').getBoundingClientRect() : null;\n" +
  "const item = document.querySelector('#graphTraceFeed .graph-item') ? document.querySelector('#graphTraceFeed .graph-item').getBoundingClientRect() : null;\n" +
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
  "};\n" +
"})()");

const LONG_DETAILS = "retry ".repeat(80);
const result = { emptyGraphs: null, emptyTrace: null, cards: null, nodes: null, running: null, trace: null, summary: null, error: null, disabled: null, sizes: { grid: {}, trace: {} } };

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#graphsCardGrid') && document.body.classList.contains('is-electron')");
      await navigateToView({ js, sleep }, "#graphs", "#viewGraphs");
      await wait("document.querySelector('#graphsCardGrid .dashboard-card') || document.querySelector('#graphsCardGrid .graphs-empty')");

      // Force the empty state through the same Refresh button a user would click.
      await js("window.__testGraphs = []");
      await js("document.querySelector('#btnRefreshGraphs').click()");
      await wait("document.querySelector('#graphsCardGrid .graphs-empty')");
      result.emptyGraphs = await js("document.querySelector('#graphsCardGrid .graphs-empty').textContent.trim()");
      result.emptyTrace = await js("document.querySelector('#graphTraceFeed .graphs-empty') ? document.querySelector('#graphTraceFeed .graphs-empty').textContent.trim() : ''");
      await shot("graphs-empty-960x740");

      await js("(() => {\n" +
        "const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } });\n" +
        "window.__graphs = [\n" +
          " { id: 'graph_ok', name: 'Orderly Graph', description: 'Plan, code, verify', cycleLimit: 5, nodes: ['plan', 'code', 'verify'] },\n" +
          " { id: 'graph_bad', name: 'Broken Graph', description: 'Always fails', nodes: ['plan'] }\n" +
        "];\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "const method = (init && init.method) || 'GET';\n" +
          "if (!url.includes('/api/graphs')) return orig(input, init);\n" +
          "if (url.includes('/api/graphs/')) {\n" +
            "const parts = url.split('/').filter(Boolean);\n" +
            "const id = decodeURIComponent(parts[parts.length - 2]);\n" +
            "if (id === 'graph_bad') { await new Promise(function(r) { setTimeout(r, 400); }); return json({ error: 'Graph run failed' }, 500); }\n" +
            "await new Promise(function(r) { setTimeout(r, 400); });\n" +
            "return json({ trace: [\n" +
              " { type: 'state_enter', node: 'plan', step: 1, timestamp: 1700000000000 },\n" +
              " { type: 'cycle_detected', node: 'review', step: 4, timestamp: 1700000000001, details: '" + LONG_DETAILS + "' },\n" +
              " { type: 'graph_complete', edge: 'verify->done', step: 5, timestamp: 1700000000002 }\n" +
            "], finalState: { finalSummary: 'All checks passed' } });\n" +
          "}\n" +
          "return json(window.__graphs);\n" +
        "};\n" +
      "return true;\n" +
    "})()");
      await js("window.__testGraphs = window.__graphs");
      await js("document.querySelector('#btnRefreshGraphs').click()");
      await wait("document.querySelectorAll('#graphsCardGrid .dashboard-card').length === 2");
      result.cards = await js("Array.from(document.querySelectorAll('#graphsCardGrid .card-title')).map((e) => e.textContent.trim())");
      result.nodes = await js("Array.from(document.querySelectorAll('#graphsCardGrid .graph-node-badge')).map((e) => e.textContent.trim())");
      await shot("graphs-grid-960x740");

      // Run the good graph: running state, trace, summary, then a failed run for the error state.
      await js("document.querySelector('#graphsCardGrid .btn-run-single-graph').click()");
      await wait("document.querySelector('#graphTraceFeed [role=status]')");
      result.running = await js("document.querySelector('#graphTraceFeed [role=status] .graph-status').textContent.trim()");
      await wait("document.querySelectorAll('#graphTraceFeed .graph-item').length >= 3");
      result.trace = await js("Array.from(document.querySelectorAll('#graphTraceFeed .graph-status')).map((e) => e.textContent.trim())");
      result.summary = await js("document.querySelector('#graphTraceFeed .graph-proposal-box') ? document.querySelector('#graphTraceFeed .graph-proposal-box').textContent.trim() : ''");
      await shot("graphs-trace-960x740");

      await js("document.querySelectorAll('#graphsCardGrid .btn-run-single-graph')[1].click()");
      await wait("document.querySelector('#graphTraceFeed .graph-status.fail')");
      result.error = await js("document.querySelector('#graphTraceFeed .graph-output-box').textContent.trim()");
      result.disabled = await js("Array.from(document.querySelectorAll('#graphsCardGrid .btn-run-single-graph')).every((b) => !b.disabled)");

      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.grid[tag] = await measure();
        result.sizes.trace[tag] = await measure();
        await shot("graphs-trace-" + tag + "-" + width + "x" + height);
      }

      console.log("__GRAPHS_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[graphs runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact graphs view, grid, trace and error states at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-graphs-home-");
  const ws = makeTempHome("opensand-graphs-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Graphs Real Window Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-graphs-harness-"));
  const runner = path.join(tmpDir, "runner-graphs.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const proofDir = process.env.OPENSAND_GRAPHS_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-graphs-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_GRAPHS_SHOT_DIR = proofDir;

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

    assert.strictEqual(code, 0, `graphs runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__GRAPHS_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.ok(res.emptyGraphs.includes("No agent graphs"), `empty grid renders (${res.emptyGraphs})`);
    assert.ok(res.emptyTrace.includes("Run a graph"), `empty trace renders (${res.emptyTrace})`);
    assert.deepStrictEqual(res.cards, ["Orderly Graph", "Broken Graph"], "both graph cards render");
    assert.deepStrictEqual(res.nodes, ["plan", "code", "verify", "plan"], "node badges render in order");
    assert.strictEqual(res.running, "RUNNING", "a run shows the running state");
    assert.deepStrictEqual(res.trace, ["STATE_ENTER", "CYCLE_DETECTED", "GRAPH_COMPLETE", "SUMMARY"], "trace events and summary render in order");
    assert.strictEqual(res.summary, "All checks passed", "final summary renders");
    assert.strictEqual(res.error, "Graph run failed", "a failed run shows the error message");
    assert.strictEqual(res.disabled, true, "run buttons re-enable after a run");

    for (const tag of ["compact", "wide"]) {
      for (const group of [res.sizes.grid, res.sizes.trace]) {
        const m = group[tag];
        assert.strictEqual(m.panelVisible, true, `${tag} panel visible`);
        assert.strictEqual(m.noOverflow, true, `${tag} has no horizontal overflow`);
        assert.strictEqual(m.gridFits, true, `${tag} grid fits`);
        assert.strictEqual(m.feedFits, true, `${tag} trace feed fits`);
      }
    }
    console.log("graphs real-window: empty/loading/error/trace states and 960x740 + 1920x1080 zero-overflow checks passed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(proofDir, { recursive: true, force: true });
  }
});
