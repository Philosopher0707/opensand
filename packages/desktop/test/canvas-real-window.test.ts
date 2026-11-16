import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { withElectronLock } from "./electron-lock.js";
import { hermeticElectronEnv, makeTempHome } from "./hermetic-env.js";

// Issue #82 in the real Electron window: the shipped renderer, real CSS, real layout.
// Tool events are delivered over the same IPC channel the engine uses ('opensand:event'),
// so app.js's own tool_result handler decides what the canvas shows.

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function skipReason(): string | undefined {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY";
  }
  if (!fs.existsSync(path.join(pkgRoot, "node_modules", ".bin", "electron"))) return "Electron binary not found";
  return undefined;
}

const RUNNER = String.raw`
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const shotDir = process.env.OPENSAND_CANVAS_SHOT_DIR || '';
const timeout = setTimeout(() => { console.error('[runner] timeout'); app.quit(); process.exit(1); }, 40000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js('Boolean(' + fn + ')')) return; await sleep(50); } throw new Error('wait timed out: ' + fn); };
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error('[js failed] ' + String(code).slice(0, 90).replace(/\s+/g, ' ')); throw e; });
const emit = (type, data) => win.webContents.send('opensand:event', { type, data });
async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  await sleep(200);
  fs.writeFileSync(path.join(shotDir, label + '.png'), (await win.webContents.capturePage()).toPNG());
}
const lines = (n, mark) => Array.from({ length: n }, (_, i) => 'const line' + (i + 1) + ' = ' + (i + 1) + '; // ' + (i + 1 === mark ? 'EDITED_MARKER' : 'row')).join('\n');
const BIG = lines(1500, 0);

const STATE = ` + "`" + String.raw`(() => { try {
  const q = (s) => document.querySelector(s);
  const pane = q('#canvasCodePane'), gut = q('#canvasLineNumbers'), pre = q('.canvas-code-pre'), strip = q('#canvasTabStrip');
  const cs = (e) => getComputedStyle(e);
  const active = strip.querySelector('.canvas-file-tab.active');
  const sr = strip.getBoundingClientRect(), ar = active ? active.getBoundingClientRect() : null;
  return {
    canvasHidden: q('#artifactCanvas').classList.contains('hidden'),
    tabs: strip.querySelectorAll('.canvas-file-tab').length,
    tabTitles: Array.from(strip.querySelectorAll('.canvas-file-tab-label')).map((e) => e.textContent),
    codeLines: pre.innerText.split(String.fromCharCode(10)).length,
    gutterLines: gut.textContent.split(String.fromCharCode(10)).length,
    codeHasMarker: pre.textContent.includes('EDITED_MARKER'),
    paneScrollTop: pane.scrollTop, paneScrollHeight: pane.scrollHeight, paneClientHeight: pane.clientHeight,
    preScrollTop: pre.scrollTop, preOverflowY: cs(pre).overflowY,
    gutterTop: Math.round(gut.getBoundingClientRect().top * 100) / 100,
    preTop: Math.round(pre.getBoundingClientRect().top * 100) / 100,
    gutterLH: cs(gut).lineHeight, preLH: cs(pre).lineHeight, gutterFS: cs(gut).fontSize, preFS: cs(pre).fontSize,
    gutterPT: cs(gut).paddingTop, prePT: cs(pre).paddingTop,
    stripOverflows: strip.scrollWidth > strip.clientWidth,
    activeVisible: !!ar && ar.left >= sr.left - 1 && ar.right <= sr.right + 1,
    activeTitle: active ? active.querySelector('.canvas-file-tab-label').textContent : null,
    diffHasRealHunk: /@@ -[0-9]+,[0-9]+ [+][0-9]+,[0-9]+ @@/.test(q('#canvasDiffContent') ? q('#canvasDiffContent').textContent : ''),
  }; } catch (e) { return { stateError: String(e && e.stack || e) }; }
})()` + "`" + String.raw`;

app.on('browser-window-created', (_e, w) => {
  win = w;
  w.webContents.on('did-finish-load', async () => {
    try {
      w.setContentSize(1280, 800);
      await js("new Promise((res) => { const t = () => document.body.classList.contains('is-electron') ? requestAnimationFrame(() => res(true)) : setTimeout(t, 25); t(); })");
      await sleep(600);
      // Start a turn the way a user would, so app.js has an assistant message to attach tool lines to.
      await js("(() => { const p = document.getElementById('promptInput'); p.value = 'edit please'; p.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('btnSend').click(); })()");
      await wait("document.querySelector('.message-assistant')");
      const call = (name, args) => emit('tool_call', { name, args });
      const result = (name, r) => emit('tool_result', { name, result: r });
      call('write_file', { path: '/proj/src/big.ts', content: BIG }); result('write_file', { status: 'ok' });
      await wait("document.querySelector('.canvas-code-pre') && document.querySelector('.canvas-code-pre').textContent.includes('const line1500')");
      call('edit_file', { path: '/proj/src/big.ts', old_string: 'const line700 = 700; // row', new_string: 'const line700 = 700; // EDITED_MARKER' });
      result('edit_file', { status: 'ok', output: { path: '/proj/src/big.ts', replacementCount: 1 } });
      await wait("document.querySelector('.canvas-code-pre') && document.querySelector('.canvas-code-pre').textContent.includes('EDITED_MARKER')");
      const edited = await js(STATE);
      if (edited.stateError) console.error(edited.stateError);
      await js("document.querySelector('#canvasTabDiff').click()");
      await wait("document.querySelector('#canvasTabDiff.active') && /@@ -[0-9]+,[0-9]+ [+][0-9]+,[0-9]+ @@/.test(document.querySelector('#canvasDiffContent') ? document.querySelector('#canvasDiffContent').textContent : '')");
      const onDiff = await js(STATE);
      await shot('1-edited-file-diff-tab');
      await js("document.querySelector('#canvasTabCode').click()");
      await wait("document.querySelector('#canvasTabCode.active')");
      await js("(() => { const p = document.getElementById('canvasCodePane'); p.scrollTop = 700 * 19.2 - 200; })()");
      await wait("document.getElementById('canvasCodePane')?.scrollTop > 5000");
      const scrolled = await js(STATE);
      await shot('2-line-numbers-after-scroll');

      for (let i = 1; i <= 11; i++) {
        call('write_file', { path: '/proj/src/module-' + i + '.ts', content: 'export const m' + i + ' = ' + i + ';\n' });
        result('write_file', { status: 'ok' });
      }
      await wait("document.querySelectorAll('#canvasTabStrip .canvas-file-tab').length === 12");
      const piled = await js(STATE);
      await shot('4-twelve-tabs');

      await js("document.getElementById('btnToggleCanvas').click()");
      await wait("document.getElementById('artifactCanvas')?.classList.contains('hidden')");
      const hidden = await js(STATE);
      await js("document.getElementById('btnToggleCanvas').click()");
      await wait("!document.getElementById('artifactCanvas')?.classList.contains('hidden')");
      const shown = await js(STATE);
      await shot('3-tabs-after-toggle-off-on');

      console.log('__CANVAS__:' + JSON.stringify({ edited, onDiff, scrolled, piled, hidden, shown }));
      console.log('CANVAS_HARNESS_PASSED');
      clearTimeout(timeout); app.quit(); process.exit(0);
    } catch (err) {
      console.error('[runner] error', err); clearTimeout(timeout); app.quit(); process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Canvas #82 in the real Electron window: full edited file, aligned gutter, toggle keeps tabs, tabs pile up", async (t) => {
  const reason = skipReason();
  if (reason) return t.skip(reason);

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-canvas-harness-"));
  const home = makeTempHome("opensand-canvas-home-");
  const runner = path.join(tmpDir, "runner.mjs");
  fs.writeFileSync(runner, RUNNER, "utf8");
  const env = hermeticElectronEnv(home);
  delete env.OPENSAND_RENDERER;
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");

  let stdout = "";
  let stderr = "";
  const code = await withElectronLock(async () => {
    const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], { cwd: pkgRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    return new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 0)));
  });
  assert.strictEqual(code, 0, `runner failed (${code})\n${stdout}\n${stderr}`);
  const m = stdout.match(/__CANVAS__:(.*)/);
  assert.ok(m, `no result in stdout:\n${stdout}\n${stderr}`);
  const r = JSON.parse(m[1]);

  // 1. edit_file: the Code tab holds the whole file as it is now, in the same tab as write_file.
  assert.strictEqual(r.edited.tabs, 1, "write then edit of one path is one tab");
  assert.strictEqual(r.edited.codeLines, 1500, "Code tab shows all 1500 lines, not the replacement");
  assert.ok(r.edited.codeHasMarker, "the edit is visible in the full file");
  assert.ok(r.onDiff.diffHasRealHunk, "Diff tab shows a real hunk");

  // 2. Gutter and code share the scroll: after scrolling deep they are still the same box.
  assert.strictEqual(r.scrolled.gutterLines, 1500);
  assert.ok(r.scrolled.paneScrollTop > 5000, `pane really scrolled (${r.scrolled.paneScrollTop})`);
  assert.strictEqual(r.scrolled.preScrollTop, 0, "the code <pre> must not be a second scroller");
  assert.strictEqual(r.scrolled.gutterTop, r.scrolled.preTop, "gutter and code move together");
  assert.strictEqual(r.scrolled.gutterLH, r.scrolled.preLH, "same line height");
  assert.strictEqual(r.scrolled.gutterFS, r.scrolled.preFS, "same font size");
  assert.strictEqual(r.scrolled.gutterPT, r.scrolled.prePT, "same top padding");

  // 4. Tabs pile up, strip scrolls, active tab visible.
  assert.strictEqual(r.piled.tabs, 12);
  assert.ok(r.piled.stripOverflows, "12 tabs overflow the strip, so it scrolls horizontally");
  assert.ok(r.piled.activeVisible, "the active tab is scrolled into view");

  // 3. Toggle off then on loses nothing.
  assert.strictEqual(r.hidden.canvasHidden, true);
  assert.strictEqual(r.hidden.tabs, 12, "hiding keeps every tab");
  assert.strictEqual(r.shown.canvasHidden, false);
  assert.strictEqual(r.shown.tabs, 12);
  assert.ok(r.shown.activeVisible, "active tab visible again after re-show");
});
