import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { withElectronLock } from "./electron-lock.js";
import { hermeticElectronEnv, makeTempHome } from "./hermetic-env.js";
import { git, makeGitWorkspace, runScriptedMission, trustFolderIn } from "./engine-mission-fixture.js";

// Restore wiring + the canvas file read, in the real Electron window against REAL files:
// a real git workspace, a real mission run by the real engine process, and the real main/preload.
// The runner reads the workspace from disk itself, so what is asserted is what is on disk.

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const shotDir = process.env.OPENSAND_RESTORE_SHOT_DIR || "";

function skipReason(): string | undefined {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY";
  }
  if (!fs.existsSync(path.join(pkgRoot, "node_modules", ".bin", "electron"))) return "Electron binary not found";
  if (!fs.existsSync(path.join(pkgRoot, "dist", "renderer-next", "index.html"))) return "dist/renderer-next is not built";
  return undefined;
}

const RUNNER_HEAD = String.raw`
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
const shotDir = process.env.OPENSAND_RESTORE_SHOT_DIR || '';
const ws = process.env.OPENSAND_TEST_WORKSPACE;
const timeout = setTimeout(() => { console.error('[runner] timeout'); app.quit(); process.exit(1); }, 50000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error('[js failed] ' + String(code).slice(0, 90)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 100; i++) { if (await js('Boolean(' + fn + ')')) return; await sleep(100); } throw new Error('wait timed out: ' + fn); };
async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  await sleep(250);
  fs.writeFileSync(path.join(shotDir, label + '.png'), (await win.webContents.capturePage()).toPNG());
}
const disk = () => {
  const out = {};
  for (const f of ['file.txt', 'extra.txt']) { const p = path.join(ws, f); out[f] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }
  return out;
};
app.on('browser-window-created', (_e, w) => {
  win = w;
  w.webContents.on('did-finish-load', async () => {
    try {
      w.setContentSize(1280, 800);
      await sleep(600);
`;
const RUNNER_TAIL = String.raw`
      clearTimeout(timeout); app.quit(); process.exit(0);
    } catch (err) {
      console.error('[runner] error', err); clearTimeout(timeout); app.quit(); process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

const RESTORE_BODY = String.raw`
      const result = { exposed: await js("[typeof window.opensand.restoreMissionSnapshot, typeof window.opensand.previewRestoreMissionSnapshot, typeof window.opensand.readWorkspaceFile]") };
      result.before = disk();
      await wait("document.querySelector('.mission-item')");
      await js("document.querySelector('.mission-item').click()");
      await wait("document.querySelector('.btn-restore-step')");
      await shot('r1-timeline');

      // 1. Click Restore to trigger preview and show dialog
      await js("document.querySelector('.btn-restore-step').click()");
      await wait("document.querySelector('.btn-restore-confirm')");
      result.previewDialog = await js("Boolean(document.querySelector('.restore-preview-lists'))");
      result.previewDeletedCount = await js("document.querySelector('.badge-deleted')?.textContent || ''");
      result.previewOverwrittenCount = await js("document.querySelector('.badge-overwritten')?.textContent || ''");
      await shot('r2-preview-dialog');

      // 2. Click Cancel: verify dialog closes and disk files remain unchanged
      await js("document.querySelector('.btn-restore-cancel').click()");
      await wait("!document.querySelector('.restore-dialog')");
      result.afterCancel = disk();

      // 3. Click Restore again and confirm
      await js("document.querySelector('.btn-restore-step').click()");
      await wait("document.querySelector('.btn-restore-confirm')");
      await js("document.querySelector('.btn-restore-confirm').click()");
      await wait("document.querySelector('.btn-restore-undo')");
      result.afterRestore = disk();
      result.toast = await js("document.querySelector('.btn-restore-undo').closest('[role]')?.textContent || ''");
      await shot('r3-restored');

      // 4. Click Undo to bring files back
      await js("document.querySelector('.btn-restore-undo').click()");
      for (let i = 0; i < 100 && disk()['file.txt'] === result.afterRestore['file.txt']; i++) await sleep(100);
      result.afterUndo = disk();
      await sleep(300);
      await shot('r4-undone');
      console.log('__RESULT__:' + JSON.stringify(result));
`;

const UNSEEN_BODY = String.raw`
      await js("(() => { const p = document.getElementById('promptInput'); p.value = 'edit the notes'; p.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('btnSend').click(); })()");
      await sleep(300);
      const target = path.join(ws, 'notes.txt');
      w.webContents.send('opensand:event', { type: 'tool_call', data: { name: 'edit_file', args: { path: target, old_string: 'beta old', new_string: 'beta NEW_MARKER' } } });
      w.webContents.send('opensand:event', { type: 'tool_result', data: { name: 'edit_file', result: { status: 'ok', output: { path: target, replacementCount: 1 } } } });
      await wait("document.querySelector('.canvas-code-pre') && document.querySelector('.canvas-code-pre').textContent.includes('NEW_MARKER') && document.querySelector('.canvas-code-pre').textContent.includes('line 12')");
      await sleep(300);
      const result = await js("(() => ({ titles: Array.from(document.querySelectorAll('.canvas-file-tab-label')).map((e) => e.textContent), code: document.querySelector('.canvas-code-pre').textContent }))()");
      await js("document.querySelector('#canvasTabDiff').click()");
      result.diff = await js("document.querySelector('#canvasDiffContent').textContent");
      await js("document.querySelector('#canvasTabCode').click()");
      await shot('u1-unseen-edit-full-file');
      console.log('__RESULT__:' + JSON.stringify(result));
`;

async function runElectron(body: string, opts: { renderer: "preact" | "legacy"; home: string; workspace: string }): Promise<any> {
  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-restore-harness-"));
  const runner = path.join(tmpDir, "runner.mjs");
  fs.writeFileSync(runner, RUNNER_HEAD + body + RUNNER_TAIL, "utf8");
  const env = hermeticElectronEnv(opts.home);
  delete env.OPENSAND_RENDERER;
  if (opts.renderer === "preact") env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_TEST_WORKSPACE = opts.workspace;
  if (shotDir) env.OPENSAND_RESTORE_SHOT_DIR = shotDir;
  let stdout = "";
  let stderr = "";
  try {
    const code = await withElectronLock(async () => {
      // cwd is the workspace: the desktop's workspaceDir defaults to process.cwd().
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], { cwd: opts.workspace, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      return new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 0)));
    });
    assert.strictEqual(code, 0, `runner failed (${code})\n${stdout}\n${stderr}`);
    const m = stdout.match(/__RESULT__:(.*)/);
    assert.ok(m, `no result in stdout:\n${stdout}\n${stderr}`);
    return JSON.parse(m[1]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("Restore in the real window: a real mission's files change on disk, then Undo brings them back", async (t) => {
  const reason = skipReason();
  if (reason) return t.skip(reason);
  const home = makeTempHome("opensand-restore-home-");
  const ws = makeGitWorkspace({ "file.txt": "initial" });
  try {
    const stateDir = path.join(home, ".opensand");
    trustFolderIn(stateDir, ws);
    await runScriptedMission(stateDir, ws, [
      { writes: { "file.txt": "step1", "extra.txt": "created by step 1" }, review: { accept: false, note: "again" } },
      { writes: { "file.txt": "step2" }, review: { accept: true, note: "ok" } },
    ]);
    assert.strictEqual(fs.readFileSync(path.join(ws, "file.txt"), "utf8"), "step2", "the mission really changed the file");

    const r = await runElectron(RESTORE_BODY, { renderer: "preact", home, workspace: ws });
    assert.deepStrictEqual(r.exposed, ["function", "function", "function"], "preload exposes restore, previewRestore, and readWorkspaceFile");
    assert.deepStrictEqual(r.before, { "file.txt": "step2", "extra.txt": "created by step 1" });
    assert.strictEqual(r.previewDialog, true, "the real Electron window rendered preview lists");
    assert.strictEqual(r.previewDeletedCount, "1", "preview shows 1 deleted file");
    assert.strictEqual(r.previewOverwrittenCount, "1", "preview shows 1 changed back file");
    assert.deepStrictEqual(r.afterCancel, r.before, "Cancel left workspace files completely unchanged on disk");
    assert.deepStrictEqual(r.afterRestore, { "file.txt": "initial", "extra.txt": null }, "Restore rewrote the files on disk");
    assert.deepStrictEqual(r.afterUndo, { "file.txt": "step2", "extra.txt": "created by step 1" }, "Undo brought them back");
    if (shotDir) {
      fs.mkdirSync(shotDir, { recursive: true });
      fs.writeFileSync(path.join(shotDir, "disk-proof.txt"), JSON.stringify({ before: r.before, afterRestore: r.afterRestore, afterUndo: r.afterUndo }, null, 2) + "\n" + git(["status", "--short"], ws));
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Canvas in the real window: an edit to a file never seen shows the whole file, read through the bridge", async (t) => {
  const reason = skipReason();
  if (reason) return t.skip(reason);
  const home = makeTempHome("opensand-unseen-home-");
  const ws = makeGitWorkspace({ "file.txt": "initial" });
  try {
    // The file as it is AFTER the edit; the window has never seen it before the edit event.
    const text = Array.from({ length: 40 }, (_, i) => (i === 4 ? "beta NEW_MARKER" : `line ${i + 1}`)).join("\n") + "\n";
    fs.writeFileSync(path.join(ws, "notes.txt"), text, "utf8");
    const r = await runElectron(UNSEEN_BODY, { renderer: "legacy", home, workspace: ws });
    assert.deepStrictEqual(r.titles, ["notes.txt"], "no (partial) in the tab title");
    assert.strictEqual(r.code.trimEnd(), text.trimEnd(), "the Code tab holds the full file from disk");
    assert.match(r.diff, /@@ -[0-9]+,[0-9]+ [+][0-9]+,[0-9]+ @@/, "the Diff tab has a real hunk");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
