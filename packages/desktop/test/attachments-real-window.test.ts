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

const shotDir = process.env.OPENSAND_ATTACHMENTS_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_ATTACHMENTS_TIMEOUT_MS || 90000);
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
  "const q = (s) => document.querySelector(s);\n" +
  "const panel = q('#viewAttachments');\n" +
  "const pr = panel ? panel.getBoundingClientRect() : null;\n" +
  "const tabs = Array.from(document.querySelectorAll('#viewAttachments .subnav-tab'));\n" +
  "const grid = q('#attachmentsCardGrid') ? q('#attachmentsCardGrid').getBoundingClientRect() : null;\n" +
  "const card = q('#attachmentsCardGrid .dashboard-card') ? q('#attachmentsCardGrid .dashboard-card').getBoundingClientRect() : null;\n" +
  "const modal = q('#stageAttachmentModal');\n" +
  "const modalOpen = modal && !modal.classList.contains('hidden');\n" +
  "const mc = modalOpen && modal.querySelector('.modal-card') ? modal.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "return {\n" +
    "innerWidth: window.innerWidth,\n" +
    "scrollWidth: document.documentElement.scrollWidth,\n" +
    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
    "tabCount: tabs.length,\n" +
    "tabsFitPanel: pr ? tabs.every((t) => { const r = t.getBoundingClientRect(); return r.left >= pr.left - 1 && r.right <= pr.right + 1; }) : false,\n" +
    "gridFits: grid ? (grid.left >= -1 && grid.right <= window.innerWidth + 1) : false,\n" +
    "cardFits: card ? (card.left >= -1 && card.right <= window.innerWidth + 1) : false,\n" +
    "modalOpen: Boolean(modalOpen),\n" +
    "modalCardFits: mc ? (mc.left >= -1 && mc.right <= window.innerWidth + 1 && mc.top >= -1 && mc.bottom <= window.innerHeight + 1) : false,\n" +
  "};\n" +
"})()");

const LONG_PATH = "/Users/philosopher/dev/" + "very-long-directory-segment-".repeat(8) + "schema.sql";
const result = { emptyState: null, initialCards: null, resetField: null, validation: null, created: null, modalClosed: null, escClosed: null, remainingCards: null, sizes: { grid: {}, modal: {} } };

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#attachmentsCardGrid') && document.body.classList.contains('is-electron')");
      await navigateToView({ js, sleep }, "#attachments", "#viewAttachments");
      await wait("!document.querySelector('#attachmentsCardGrid .attachments-loading')");

      result.emptyState = await js("document.querySelector('#attachmentsCardGrid .attachments-empty') ? document.querySelector('#attachmentsCardGrid .attachments-empty').textContent.trim() : ''");
      result.initialCards = await js("document.querySelectorAll('#attachmentsCardGrid .dashboard-card').length");
      await shot("attachments-empty-960x740");

      // Stub only the attachment routes so stage/unstage are deterministic and use bridge-shaped records.
      await js("(() => {\n" +
        "const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } });\n" +
        "window.__atts = [];\n" +
        "window.confirm = () => true;\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "const method = (init && init.method) || 'GET';\n" +
          "if (!url.includes('/api/attachments')) return orig(input, init);\n" +
          "if (url.endsWith('/api/attachments')) {\n" +
            "if (method === 'GET') return json(window.__atts);\n" +
            "if (method === 'POST') {\n" +
              "const body = JSON.parse((init && init.body) || '{}');\n" +
              "if (!body.filePath) return json({ error: 'Missing filePath' }, 400);\n" +
              "const att = { id: 'att_' + (window.__atts.length + 1), filename: body.filePath.split('/').slice(-1)[0], localPath: body.filePath, sizeBytes: 4096, mimeType: 'application/octet-stream', sha256: 'abcdef0123456789' + '0'.repeat(48), stagedAtMs: Date.now() };\n" +
              "window.__atts = [...window.__atts, att];\n" +
              "return json(att, 201);\n" +
            "}\n" +
          "}\n" +
          "if (method === 'DELETE') {\n" +
            "const id = decodeURIComponent(url.split('/').slice(-1)[0]);\n" +
            "window.__atts = window.__atts.filter((a) => a.id !== id);\n" +
            "return json({ success: true });\n" +
          "}\n" +
          "return json([]);\n" +
        "};\n" +
      "return true;\n" +
    "})()");

      // Stage modal opens with a reset field, then inline validation on empty input.
      await js("document.querySelector('#btnOpenStageAttachment').click()");
      await wait("!document.querySelector('#stageAttachmentModal').classList.contains('hidden')");
      result.resetField = await js("document.querySelector('#attachmentFilePath').value");
      await js("document.querySelector('#btnSaveStageAttachment').click()");
      await wait("document.querySelector('#attachmentsFormError').textContent.includes('Please provide a local file path')");
      result.validation = await js("document.querySelector('#attachmentsFormError').textContent.trim()");
      await shot("attachments-validation-960x740");

      // Stage a record with a long single-line path: it must not widen the page or the modal.
      await js(setInput('#attachmentFilePath', LONG_PATH));
      await js("document.querySelector('#btnSaveStageAttachment').click()");
      await wait("document.querySelectorAll('#attachmentsCardGrid .dashboard-card').length === 1");
      await wait("document.querySelector('#stageAttachmentModal').classList.contains('hidden')");
      result.created = await js("({ title: document.querySelector('#attachmentsCardGrid .card-title').textContent.trim(), path: document.querySelector('#attachmentsCardGrid .attachment-path').textContent.trim(), status: document.querySelector('#attachmentsCardGrid .card-top .badge')?.textContent.trim(), badges: Array.from(document.querySelectorAll('#attachmentsCardGrid .card-meta .badge')).map((b) => b.textContent.trim()), hash: document.querySelector('#attachmentsCardGrid .attachment-hash')?.textContent.trim(), pathFits: document.querySelector('#attachmentsCardGrid .attachment-path').scrollWidth <= document.querySelector('#attachmentsCardGrid .attachment-path').clientWidth })");
      await shot("attachments-card-created-960x740");

      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.grid[tag] = await measure();
        await shot("attachments-grid-" + tag + "-" + width + "x" + height);
      }

      // Modal at both sizes, then close with the button and with Escape.
      await js("document.querySelector('#btnOpenStageAttachment').click()");
      await wait("!document.querySelector('#stageAttachmentModal').classList.contains('hidden')");
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.modal[tag] = await measure();
        await shot("attachments-modal-" + tag + "-" + width + "x" + height);
      }
      await js("document.querySelector('#btnCloseStageAttachment').click()");
      await wait("document.querySelector('#stageAttachmentModal').classList.contains('hidden')");
      result.modalClosed = true;

      await js("document.querySelector('#btnOpenStageAttachment').click()");
      await wait("!document.querySelector('#stageAttachmentModal').classList.contains('hidden')");
      await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await wait("document.querySelector('#stageAttachmentModal').classList.contains('hidden')");
      result.escClosed = true;

      // Unstage with confirm removes the card and refreshes the grid.
      await js("document.querySelector('#attachmentsCardGrid .btn-del-att').click()");
      await wait("document.querySelectorAll('#attachmentsCardGrid .dashboard-card').length === 0");
      result.remainingCards = await js("document.querySelectorAll('#attachmentsCardGrid .dashboard-card').length");

      console.log("__ATTACHMENTS_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[attachments runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact attachments view, stage modal and unstage at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-attachments-home-");
  const ws = makeTempHome("opensand-attachments-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Attachments Real Window Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-attachments-harness-"));
  const runner = path.join(tmpDir, "runner-attachments.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const proofDir = process.env.OPENSAND_ATTACHMENTS_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-attachments-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_ATTACHMENTS_SHOT_DIR = proofDir;

  let stdout = "";
  let stderr = "";

  const killGroup = (child: import("node:child_process").ChildProcess) => {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  };

  try {
    const code = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], {
        cwd: ws,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
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
        watchdog = setTimeout(() => { killGroup(child); settle(124); }, 180_000);
        // Resolve on process exit; the helper releases pipes held by lingering Electron helpers.
        void whenElectronExited(child).then(settle);
        child.on("error", (err) => { stderr += String(err); settle(1); });
      });
    });

    assert.strictEqual(code, 0, `attachments runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__ATTACHMENTS_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.ok(res.emptyState.includes("No staged context attachments."), `empty state renders (${JSON.stringify(res.emptyState)})`);
    assert.strictEqual(res.initialCards, 0, "fresh state has no attachment cards");
    assert.strictEqual(res.resetField, "", "stage modal opens with a reset path field");
    assert.strictEqual(res.validation, "Please provide a local file path.", "empty path is rejected inline");
    assert.ok(res.created.title.includes("schema.sql"), `created card shows the filename (${res.created.title})`);
    assert.ok(res.created.path.includes("schema.sql"), "created card shows the file path");
    assert.strictEqual(res.created.status, "Staged", "created card shows the Staged badge");
    assert.deepStrictEqual(res.created.badges, ["4 KB"], "created card shows the KB size badge");
    assert.ok(res.created.hash.includes("SHA: abcdef0123456789..."), `created card shows a 16-char hash (${res.created.hash})`);
    assert.strictEqual(res.created.pathFits, true, "long single-line path wraps instead of widening the card");
    assert.strictEqual(res.modalClosed, true, "the close button dismisses the stage modal");
    assert.strictEqual(res.escClosed, true, "Escape dismisses the stage modal");
    assert.strictEqual(res.remainingCards, 0, "unstage removes the card and refreshes the grid");

    for (const kind of ["grid", "modal"] as const) {
      for (const [tag, width, height] of [["compact", 960, 740], ["wide", 1920, 1080]] as const) {
        const size = res.sizes[kind][tag];
        assert.ok(size, `${kind} ${tag} ${width}x${height} metrics present`);
        assert.strictEqual(size.noOverflow, true, `${kind} ${tag}: zero horizontal overflow (${size.scrollWidth} <= ${size.innerWidth})`);
        assert.strictEqual(size.tabCount, 6, `${kind} ${tag}: all six Connections tabs render`);
        assert.strictEqual(size.tabsFitPanel, true, `${kind} ${tag}: subnav tabs stay inside their panel`);
        assert.strictEqual(size.gridFits, true, `${kind} ${tag}: attachments grid fits the window`);
        if (kind === "grid") {
          assert.strictEqual(size.cardFits, true, `${kind} ${tag}: attachment card fits the window`);
        } else {
          assert.strictEqual(size.modalOpen, true, `${kind} ${tag}: stage modal is open`);
          assert.strictEqual(size.modalCardFits, true, `${kind} ${tag}: stage modal card fits the window`);
        }
      }
    }

    console.log("[proof] attachments real-window screenshots written to:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
