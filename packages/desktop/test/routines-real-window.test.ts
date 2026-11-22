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
import fs from "node:fs";
import path from "node:path";

const shotDir = process.env.OPENSAND_ROUTINES_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_ROUTINES_TIMEOUT_MS || 120000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const nativeSet = (sel, proto, value, eventName) => "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); Object.getOwnPropertyDescriptor(" + proto + ".prototype, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event(" + JSON.stringify(eventName) + ", { bubbles: true })); return true; })()";
const setInput = (sel, value) => nativeSet(sel, "HTMLInputElement", value, "input");
const setArea = (sel, value) => nativeSet(sel, "HTMLTextAreaElement", value, "input");
const setSelect = (sel, value) => nativeSet(sel, "HTMLSelectElement", value, "change");

async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await sleep(250);
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}

const measure = () => js("(() => {\n" +
  "const q = (s) => document.querySelector(s);\n" +
  "const panel = q('#viewRoutines');\n" +
  "const pr = panel ? panel.getBoundingClientRect() : null;\n" +
  "const tabs = Array.from(document.querySelectorAll('#viewRoutines .subnav-tab'));\n" +
  "const gr = q('#routinesCardGrid') ? q('#routinesCardGrid').getBoundingClientRect() : null;\n" +
  "const cr = q('#routinesCardGrid .dashboard-card') ? q('#routinesCardGrid .dashboard-card').getBoundingClientRect() : null;\n" +
  "const modal = q('#createRoutineModal');\n" +
  "const openModal = modal && !modal.classList.contains('hidden');\n" +
  "const mr = openModal && modal.querySelector('.modal-card') ? modal.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "return {\n" +
    "innerWidth: window.innerWidth,\n" +
    "scrollWidth: document.documentElement.scrollWidth,\n" +
    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
    "tabCount: tabs.length,\n" +
    "tabsFitPanel: pr ? tabs.every((t) => { const r = t.getBoundingClientRect(); return r.left >= pr.left - 1 && r.right <= pr.right + 1; }) : false,\n" +
    "gridFits: gr ? (gr.left >= -1 && gr.right <= window.innerWidth + 1) : false,\n" +
    "cardFits: cr ? (cr.left >= -1 && cr.right <= window.innerWidth + 1) : false,\n" +
    "modalOpen: Boolean(openModal),\n" +
    "modalCardFits: mr ? (mr.left >= -1 && mr.right <= window.innerWidth + 1 && mr.top >= -1 && mr.bottom <= window.innerHeight + 1) : false,\n" +
  "};\n" +
"})()");

const result = { emptyState: null, initialCards: null, resetFields: null, validation: null, cronGroups: null, intervalGroups: null, created: null, runNow: null, toggle: null, remainingCards: null, sizes: { grid: {}, modal: {} } };

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#routinesCardGrid') && document.body.classList.contains('is-electron')");
      await js("window.location.hash = '#routines'");
      await wait("document.querySelector('#viewRoutines') && !document.querySelector('#viewRoutines').classList.contains('hidden')");
      await wait("!document.querySelector('#routinesCardGrid .routines-loading')");

      // 1. Fresh state: the grid renders the empty state and no cards.
      result.emptyState = await js("document.querySelector('#routinesCardGrid .routines-empty') ? document.querySelector('#routinesCardGrid .routines-empty').textContent.trim() : ''");
      result.initialCards = await js("document.querySelectorAll('#routinesCardGrid .dashboard-card').length");
      await shot("routines-empty-960x740");

      // 2. Stub only the routine routes so creation and controls are deterministic.
      await js("(() => {\n" +
        "const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } });\n" +
        "window.__routines = [];\n" +
        "window.confirm = () => true;\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "const method = (init && init.method) || 'GET';\n" +
          "if (!url.includes('/api/routines')) return orig(input, init);\n" +
          "if (url.endsWith('/api/routines')) {\n" +
            "if (method === 'GET') return json(window.__routines);\n" +
            "if (method === 'POST') {\n" +
              "const body = JSON.parse((init && init.body) || '{}');\n" +
              "const routine = { routineId: 'routine_' + (window.__routines.length + 1), name: body.name, recordJson: JSON.stringify({ prompt: body.prompt }), triggerDescription: body.scheduleType === 'cron' ? 'cron ' + body.cron : 'every ' + body.intervalMinutes + ' minutes', nextRunAtMs: null, runCount: 0, isEnabled: true };\n" +
              "window.__routines = [...window.__routines, routine];\n" +
              "return json(routine, 201);\n" +
            "}\n" +
          "}\n" +
          "if (url.includes('/enabled') && method === 'PATCH') {\n" +
            "const id = url.split('/').slice(-2)[0];\n" +
            "const body = JSON.parse((init && init.body) || '{}');\n" +
            "window.__routines = window.__routines.map((r) => r.routineId === id ? { ...r, isEnabled: body.isEnabled } : r);\n" +
            "return json(window.__routines.find((r) => r.routineId === id));\n" +
          "}\n" +
          "if (url.includes('/trigger') && method === 'POST') {\n" +
            "await new Promise((r) => setTimeout(r, 400));\n" +
            "return json({ status: 'success' });\n" +
          "}\n" +
          "if (method === 'DELETE') {\n" +
            "const id = url.split('/').slice(-1)[0];\n" +
            "window.__routines = window.__routines.filter((r) => r.routineId !== id);\n" +
            "return json({ deleted: true });\n" +
          "}\n" +
          "return json([]);\n" +
        "};\n" +
      "return true;\n" +
    "})()");

      // 3. Modal opens with reset fields; an empty name is rejected inline.
      await js("document.querySelector('#btnOpenCreateRoutine').click()");
      await wait("!document.querySelector('#createRoutineModal').classList.contains('hidden')");
      result.resetFields = await js("({ name: document.querySelector('#routineName').value, prompt: document.querySelector('#routinePrompt').value, scheduleType: document.querySelector('#routineScheduleType').value, interval: document.querySelector('#routineIntervalMinutes').value, cron: document.querySelector('#routineCron').value, intervalVisible: !document.querySelector('#groupInterval').classList.contains('hidden'), cronVisible: !document.querySelector('#groupCron').classList.contains('hidden') })");
      await js("document.querySelector('#btnSaveRoutine').click()");
      await wait("document.querySelector('#routineFormError').textContent.includes('Please provide routine name')");
      result.validation = await js("document.querySelector('#routineFormError').textContent.trim()");
      await shot("routines-validation-960x740");

      // 4. Cron toggles the two schedule groups; switching back restores the interval group.
      await js(setSelect('#routineScheduleType', 'cron'));
      await wait("!document.querySelector('#groupCron').classList.contains('hidden') && document.querySelector('#groupInterval').classList.contains('hidden')");
      result.cronGroups = await js("({ cronVisible: !document.querySelector('#groupCron').classList.contains('hidden'), intervalVisible: !document.querySelector('#groupInterval').classList.contains('hidden') })");
      await js(setSelect('#routineScheduleType', 'interval'));
      await wait("!document.querySelector('#groupInterval').classList.contains('hidden') && document.querySelector('#groupCron').classList.contains('hidden')");
      result.intervalGroups = await js("({ cronVisible: !document.querySelector('#groupCron').classList.contains('hidden'), intervalVisible: !document.querySelector('#groupInterval').classList.contains('hidden') })");

      // 5. Create an interval routine.
      await js(setInput('#routineName', 'Hourly Diagnostics'));
      await js(setArea('#routinePrompt', 'Check disk space and error logs'));
      await js(setInput('#routineIntervalMinutes', '30'));
      await js("document.querySelector('#btnSaveRoutine').click()");
      await wait("document.querySelectorAll('#routinesCardGrid .dashboard-card').length === 1");
      await wait("document.querySelector('#createRoutineModal').classList.contains('hidden')");
      result.created = await js("({ title: document.querySelector('#routinesCardGrid .card-title').textContent.trim(), action: document.querySelector('#routinesCardGrid .card-desc').textContent.trim(), trigger: document.querySelector('#routinesCardGrid .card-meta .badge').textContent.trim(), toggle: document.querySelector('#routinesCardGrid .btn-toggle').textContent.trim() })");
      await shot("routines-card-created-960x740");

      // 6. Reopening resets fields, then a cron routine is created too.
      await js("document.querySelector('#btnOpenCreateRoutine').click()");
      await wait("!document.querySelector('#createRoutineModal').classList.contains('hidden')");
      await js(setInput('#routineName', 'Weekday Standup'));
      await js(setArea('#routinePrompt', 'Summarise open pull requests'));
      await js(setSelect('#routineScheduleType', 'cron'));
      await wait("!document.querySelector('#groupCron').classList.contains('hidden')");
      await js(setInput('#routineCron', '0 9 * * 1-5'));
      await js("document.querySelector('#btnSaveRoutine').click()");
      await wait("document.querySelectorAll('#routinesCardGrid .dashboard-card').length === 2");
      await shot("routines-two-cards-960x740");

      // 7. Run Now disables the button while the call runs, then restores it.
      await js("document.querySelector('#routinesCardGrid .btn-trigger').click()");
      await wait("document.querySelector('#routinesCardGrid .btn-trigger').disabled");
      result.runNow = { disabled: await js("document.querySelector('#routinesCardGrid .btn-trigger').disabled"), text: await js("document.querySelector('#routinesCardGrid .btn-trigger').textContent.trim()") };
      await wait("!document.querySelector('#routinesCardGrid .btn-trigger').disabled && document.querySelector('#routinesCardGrid .btn-trigger').textContent.includes('Run Now')");
      result.runNow.restored = await js("document.querySelector('#routinesCardGrid .btn-trigger').textContent.trim()");

      // 8. Pause flips to Enable, then back to Pause after the server update.
      await wait("document.querySelector('#routinesCardGrid .btn-toggle').textContent.includes('Pause')");
      await js("document.querySelector('#routinesCardGrid .btn-toggle').click()");
      await wait("document.querySelector('#routinesCardGrid .btn-toggle').textContent.includes('Enable')");
      const enabledLabel = await js("document.querySelector('#routinesCardGrid .btn-toggle').textContent.trim()");
      await js("document.querySelector('#routinesCardGrid .btn-toggle').click()");
      await wait("document.querySelector('#routinesCardGrid .btn-toggle').textContent.includes('Pause')");
      result.toggle = { pausedTo: enabledLabel, backTo: await js("document.querySelector('#routinesCardGrid .btn-toggle').textContent.trim()") };

      // 9. Delete uses a confirm dialog and refreshes the list.
      await js("document.querySelector('#routinesCardGrid .btn-del-routine').click()");
      await wait("document.querySelectorAll('#routinesCardGrid .dashboard-card').length === 1");
      result.remainingCards = await js("document.querySelectorAll('#routinesCardGrid .dashboard-card').length");

      // 10. Responsive checks. State changes are done above and between loops, never inside a loop.
      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.grid[tag] = await measure();
        await shot("routines-grid-" + tag + "-" + width + "x" + height);
      }
      await js("document.querySelector('#btnOpenCreateRoutine').click()");
      await wait("!document.querySelector('#createRoutineModal').classList.contains('hidden')");
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.modal[tag] = await measure();
        await shot("routines-create-" + tag + "-" + width + "x" + height);
      }

      console.log("__ROUTINES_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[routines runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact routines view, creation and controls at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-routines-home-");
  const ws = makeTempHome("opensand-routines-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Routines Real Window Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-routines-harness-"));
  const runner = path.join(tmpDir, "runner-routines.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const proofDir = process.env.OPENSAND_ROUTINES_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-routines-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  // os.homedir() ignores HOME on macOS: the state dir must be explicit or the test touches live state.
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_ROUTINES_SHOT_DIR = proofDir;

  let stdout = "";
  let stderr = "";

  try {
    const code = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], {
        cwd: ws,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", (err) => {
        stderr += String(err);
      });
      // A runner that fails to parse never emits "close" and would hang the suite silently.
      return new Promise<number>((resolve) => {
        const watchdog = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(124);
        }, 180_000);
        child.on("close", (c) => {
          clearTimeout(watchdog);
          resolve(c ?? 0);
        });
      });
    });

    assert.strictEqual(code, 0, `routines runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__ROUTINES_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.ok(res.emptyState.includes("No background routines configured."), `empty state renders (${JSON.stringify(res.emptyState)})`);
    assert.strictEqual(res.initialCards, 0, "fresh state has no routine cards");
    assert.deepStrictEqual(res.resetFields, {
      name: "", prompt: "", scheduleType: "interval", interval: "60", cron: "",
      intervalVisible: true, cronVisible: false,
    }, "create modal opens with reset fields");
    assert.strictEqual(res.validation, "Please provide routine name and prompt instructions.", "empty name is rejected inline");
    assert.deepStrictEqual(res.cronGroups, { cronVisible: true, intervalVisible: false }, "cron schedule shows only the cron group");
    assert.deepStrictEqual(res.intervalGroups, { cronVisible: false, intervalVisible: true }, "interval schedule shows only the interval group");
    assert.ok(res.created.title.includes("Hourly Diagnostics"), `created card shows the name (${res.created.title})`);
    assert.ok(res.created.action.includes("Check disk space and error logs"), `created card shows the action prompt (${res.created.action})`);
    assert.strictEqual(res.created.trigger, "every 30 minutes", "created card shows the interval trigger");
    assert.strictEqual(res.created.toggle, "Pause", "enabled routine offers Pause");
    assert.strictEqual(res.runNow.disabled, true, "Run Now disables while the call runs");
    assert.strictEqual(res.runNow.text, "Running...", "Run Now shows Running... while the call runs");
    assert.strictEqual(res.runNow.restored, "Run Now", "Run Now is restored after the call");
    assert.deepStrictEqual(res.toggle, { pausedTo: "Enable", backTo: "Pause" }, "Pause and Enable flip after each update");
    assert.strictEqual(res.remainingCards, 1, "delete removes one card and refreshes the grid");

    for (const kind of ["grid", "modal"] as const) {
      for (const [tag, width, height] of [["compact", 960, 740], ["wide", 1920, 1080]] as const) {
        const size = res.sizes[kind][tag];
        assert.ok(size, `${kind} ${tag} ${width}x${height} metrics present`);
        assert.strictEqual(size.noOverflow, true, `${kind} ${tag}: zero horizontal overflow (${size.scrollWidth} <= ${size.innerWidth})`);
        assert.strictEqual(size.tabCount, 4, `${kind} ${tag}: all four Capabilities tabs render`);
        assert.strictEqual(size.tabsFitPanel, true, `${kind} ${tag}: subnav tabs stay inside their panel`);
        assert.strictEqual(size.gridFits, true, `${kind} ${tag}: routines grid fits the window`);
        if (kind === "grid") {
          assert.strictEqual(size.cardFits, true, `${kind} ${tag}: routine card fits the window`);
        } else {
          assert.strictEqual(size.modalOpen, true, `${kind} ${tag}: create routine modal is open`);
          assert.strictEqual(size.modalCardFits, true, `${kind} ${tag}: modal card fits the window`);
        }
      }
    }

    console.log("[proof] routines real-window screenshots written to:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
