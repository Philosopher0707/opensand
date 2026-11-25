import { whenElectronExited } from "./helpers/electron-exit.js";
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
  env.OPENSAND_RENDERER = "legacy";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");

  let stdout = "";
  let stderr = "";
  const code = await withElectronLock(async () => {
    const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], { cwd: pkgRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    return whenElectronExited(child);
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

// ---------------------------------------------------------------------------
// Preact Shell Canvas Split View Real-Window Verification (Phase 5 Row 5)
// ---------------------------------------------------------------------------

import { makeGitWorkspace, trustFolderIn } from "./engine-mission-fixture.js";

const PREACT_CANVAS_RUNNER = [
  'import { app } from "electron";',
  'import fs from "node:fs";',
  'import path from "node:path";',
  'const shotDir = process.env.OPENSAND_CANVAS_SHOT_DIR || "";',
  'const TARGET_SESSION_ID = process.env.OPENSAND_TARGET_SESSION_ID || "sess-canvas-1";',
  'const TIMEOUT_MS = Number(process.env.OPENSAND_CANVAS_TIMEOUT_MS || 90000);',
  '',
  'const timeout = setTimeout(() => { console.error("[preact-runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);',
  'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
  'let win;',
  'const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 90)); throw e; });',
  'const wait = async (fn) => { for (let i = 0; i < 150; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };',
  '',
  'async function shot(label) {',
  '  if (!shotDir) return;',
  '  fs.mkdirSync(shotDir, { recursive: true });',
  '  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");',
  '  await sleep(250);',
  '  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());',
  '}',
  '',
  'app.on("browser-window-created", (_e, w) => {',
  '  win = w;',
  '  w.webContents.on("did-finish-load", async () => {',
  '    try {',
  '      await wait("document.querySelector(\'#promptInput\') && document.body.classList.contains(\'is-electron\')");',
  '      await wait("document.querySelectorAll(\'.session-channel-item\').length > 0");',
  '',
  '      // Select session in sidebar',
  '      const clicked = await js("(() => { const items = [...document.querySelectorAll(\'.session-channel-item\')]; const item = items.find((el) => el.getAttribute(\'data-session-id\') === " + JSON.stringify(TARGET_SESSION_ID) + ") || items[0]; if (item) { item.click(); return true; } return false; })()");',
  '      if (!clicked) throw new Error("Could not find session item for " + TARGET_SESSION_ID);',
  '',
  '      await wait("document.querySelectorAll(\'#messageFeed .message\').length >= 2");',
  '      await wait("document.querySelector(\'.tool-line\')");',
  '      await wait("document.querySelector(\'.code-block-wrapper\')");',
  '',
  '      // 1. Initial window size: 960x740 (compact)',
  '      win.setContentSize(960, 740);',
  '      await sleep(300);',
  '',
  '      // Step 1: Open file from tool card into Canvas',
  '      await wait("document.querySelector(\'.tool-line .btn-open-canvas\')");',
  '      await js("document.querySelector(\'.tool-line .btn-open-canvas\').click()");',
  '      await wait("document.querySelector(\'.chat-canvas-split.canvas-open\')");',
  '      await wait("document.querySelector(\'#artifactCanvas\')");',
  '      await wait("document.querySelectorAll(\'#canvasTabStrip .canvas-file-tab\').length === 1");',
  '',
  '      const tab1Title = await js("document.querySelector(\'#canvasTabStrip .canvas-file-tab.active .canvas-file-tab-label\')?.textContent");',
  '      const code1Content = await js("document.querySelector(\'.canvas-code-content\')?.textContent");',
  '      const lineNums = await js("document.querySelector(\'#canvasLineNumbers\')?.textContent");',
  '',
  '      // Step 2: Open code block from markdown message into Canvas as second tab',
  '      await wait("document.querySelector(\'.code-block-wrapper .btn-open-canvas\')");',
  '      await js("document.querySelector(\'.code-block-wrapper .btn-open-canvas\').click()");',
  '      await wait("document.querySelectorAll(\'#canvasTabStrip .canvas-file-tab\').length === 2");',
  '',
  '      const tabsAfterAdd = await js("document.querySelectorAll(\'#canvasTabStrip .canvas-file-tab\').length");',
  '      const tab2Title = await js("document.querySelector(\'#canvasTabStrip .canvas-file-tab.active .canvas-file-tab-label\')?.textContent");',
  '',
  '      // Step 3: Switch back to first tab',
  '      await js("document.querySelectorAll(\'#canvasTabStrip .canvas-file-tab\')[0].click()");',
  '      await sleep(150);',
  '      const activeAfterSwitch = await js("document.querySelector(\'#canvasTabStrip .canvas-file-tab.active .canvas-file-tab-label\')?.textContent");',
  '',
  '      // Step 4: Measure compact layout metrics at 960x740',
  '      const compactMetrics = await js("(() => { const split = document.querySelector(\'.chat-canvas-split\'); const chatP = document.querySelector(\'.chat-split-pane\'); const canP = document.querySelector(\'.canvas-split-pane\'); const sr = split ? split.getBoundingClientRect() : null; const cr = chatP ? chatP.getBoundingClientRect() : null; const ar = canP ? canP.getBoundingClientRect() : null; return { noOverflow: document.documentElement.scrollWidth <= window.innerWidth, splitWidth: sr ? sr.width : 0, chatWidth: cr ? cr.width : 0, canvasWidth: ar ? ar.width : 0, isCanvasOpen: split ? split.classList.contains(\'canvas-open\') : false }; })()");',
  '      await shot("compact-canvas-split");',
  '',
  '      // Step 5: Resize to wide window: 1920x1080',
  '      win.setContentSize(1920, 1080);',
  '      await sleep(300);',
  '      const wideMetrics = await js("(() => { const split = document.querySelector(\'.chat-canvas-split\'); const chatP = document.querySelector(\'.chat-split-pane\'); const canP = document.querySelector(\'.canvas-split-pane\'); const sr = split ? split.getBoundingClientRect() : null; const cr = chatP ? chatP.getBoundingClientRect() : null; const ar = canP ? canP.getBoundingClientRect() : null; return { noOverflow: document.documentElement.scrollWidth <= window.innerWidth, splitWidth: sr ? sr.width : 0, chatWidth: cr ? cr.width : 0, canvasWidth: ar ? ar.width : 0, isCanvasOpen: split ? split.classList.contains(\'canvas-open\') : false }; })()");',
  '      await shot("wide-canvas-split");',
  '',
  '      // Step 6: Close active tab',
  '      await js("document.querySelector(\'#canvasTabStrip .canvas-file-tab.active .canvas-file-tab-close\').click()");',
  '      await wait("document.querySelectorAll(\'#canvasTabStrip .canvas-file-tab\').length === 1");',
  '      const tabsAfterClose = await js("document.querySelectorAll(\'#canvasTabStrip .canvas-file-tab\').length");',
  '',
  '      // Step 7: Close canvas entirely',
  '      await js("document.querySelector(\'#btnCloseCanvas\').click()");',
  '      await wait("document.querySelector(\'.chat-canvas-split.canvas-closed\')");',
  '      const metricsAfterClose = await js("(() => { const split = document.querySelector(\'.chat-canvas-split\'); const canP = document.querySelector(\'.canvas-split-pane\'); return { isClosed: split ? split.classList.contains(\'canvas-closed\') : false, canvasHidden: canP ? (getComputedStyle(canP).display === \'none\') : true, noOverflow: document.documentElement.scrollWidth <= window.innerWidth }; })()");',
  '',
  '      // Step 8: Re-open canvas via topbar toggle button',
  '      await wait("document.querySelector(\'#btnToggleCanvas\')");',
  '      await js("document.querySelector(\'#btnToggleCanvas\').click()");',
  '      await wait("document.querySelector(\'.chat-canvas-split.canvas-open\')");',
  '      const reOpened = await js("Boolean(document.querySelector(\'.chat-canvas-split.canvas-open\'))");',
  '',
  '      const result = {',
  '        tab1Title,',
  '        code1HasContent: Boolean(code1Content && code1Content.includes("add")),',
  '        hasLineNumbers: Boolean(lineNums && lineNums.includes("1")),',
  '        tabsAfterAdd,',
  '        tab2Title,',
  '        activeAfterSwitch,',
  '        compactMetrics,',
  '        wideMetrics,',
  '        tabsAfterClose,',
  '        metricsAfterClose,',
  '        reOpened,',
  '      };',
  '',
  '      console.log("__PREACT_CANVAS_RESULT__:" + JSON.stringify(result));',
  '      clearTimeout(timeout);',
  '      app.quit();',
  '      process.exit(0);',
  '    } catch (err) {',
  '      console.error("[preact-runner] error", err);',
  '      clearTimeout(timeout);',
  '      app.quit();',
  '      process.exit(1);',
  '    }',
  '  });',
  '});',
  'await import(process.env.OPENSAND_MAIN);',
].join("\n");

test("Preact canvas split view, tab switching, and responsiveness at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const sessionId = "sess-canvas-split-1";
  const home = makeTempHome("opensand-canvas-split-home-");
  const ws = makeGitWorkspace({ "README.md": "# Canvas Split Test" });
  await trustFolderIn(home, ws);

  const sessDir = path.join(home, ".opensand", "sessions", sessionId);
  fs.mkdirSync(sessDir, { recursive: true });
  const events = [
    { role: "user", content: "Can you generate a helper module and some demo code?" },
    {
      role: "assistant",
      thought: "I will generate the math utility and demo script.",
      content: "Here is the implementation:\n\n```typescript\nimport { add } from './utils';\nconsole.log(add(1, 2));\n```\n",
      tool_calls: [
        {
          id: "call_write_1",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "src/utils.ts",
              content: "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
            }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_write_1",
      result: { success: true },
    },
  ];
  const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(path.join(sessDir, "transcript.jsonl"), jsonl, "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-canvas-preact-harness-"));
  const runner = path.join(tmpDir, "runner-preact.mjs");
  fs.writeFileSync(runner, PREACT_CANVAS_RUNNER, "utf8");

  const env = hermeticElectronEnv(home);
  delete env.OPENSAND_RENDERER;
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_TARGET_SESSION_ID = sessionId;

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
      return whenElectronExited(child);
    });

    assert.strictEqual(code, 0, `preact canvas runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__PREACT_CANVAS_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.strictEqual(res.tab1Title, "utils.ts", "tool card opened utils.ts tab");
    assert.strictEqual(res.code1HasContent, true, "utils.ts content is displayed in code pane");
    assert.strictEqual(res.hasLineNumbers, true, "line numbers are rendered");
    assert.strictEqual(res.tabsAfterAdd, 2, "code block added second tab");
    assert.strictEqual(res.tab2Title, "Snippet.typescript", "second tab has expected label");
    assert.strictEqual(res.activeAfterSwitch, "utils.ts", "switching tab activates utils.ts");
    assert.strictEqual(res.compactMetrics.noOverflow, true, "compact 960x740: zero horizontal overflow in split view");
    assert.ok(res.compactMetrics.chatWidth > 0, "compact 960x740: chat pane has positive width");
    assert.ok(res.compactMetrics.canvasWidth > 0, "compact 960x740: canvas pane has positive width");
    assert.strictEqual(res.wideMetrics.noOverflow, true, "wide 1920x1080: zero horizontal overflow in split view");
    assert.ok(res.wideMetrics.chatWidth > 0, "wide 1920x1080: chat pane has positive width");
    assert.ok(res.wideMetrics.canvasWidth > 0, "wide 1920x1080: canvas pane has positive width");
    assert.strictEqual(res.tabsAfterClose, 1, "closing tab leaves 1 tab");
    assert.strictEqual(res.metricsAfterClose.isClosed, true, "closing canvas updates split state");
    assert.strictEqual(res.metricsAfterClose.canvasHidden, true, "canvas is hidden after close");
    assert.strictEqual(res.metricsAfterClose.noOverflow, true, "zero horizontal overflow when closed");
    assert.strictEqual(res.reOpened, true, "topbar button re-opens canvas");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
