import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { withElectronLock } from "./electron-lock.js";
import { hermeticElectronEnv, makeTempHome } from "./hermetic-env.js";

type Renderer = "default" | "preact";

interface HarnessOptions {
  forceOverflow?: boolean;
  home?: string;
  shotTag?: string;
  interactScript?: string;
}

interface HarnessResult {
  skipped?: string;
  res960?: any;
  res1920?: any;
  interactResult?: any;
  home?: string;
}

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function seedSessions(
  home: string,
  sessions: Array<{ id: string; firstLine: string; mtime?: Date | number }>
): void {
  const baseSessionsDir = path.join(home, ".opensand", "sessions");
  for (const s of sessions) {
    const sessDir = path.join(baseSessionsDir, s.id);
    fs.mkdirSync(sessDir, { recursive: true });
    const jsonlPath = path.join(sessDir, "transcript.jsonl");
    fs.writeFileSync(jsonlPath, JSON.stringify({ role: "user", content: s.firstLine }) + "\n", "utf8");
    if (s.mtime !== undefined) {
      const m = s.mtime instanceof Date ? s.mtime : new Date(s.mtime);
      fs.utimesSync(jsonlPath, m, m);
      fs.utimesSync(sessDir, m, m);
    }
  }
}

function skipReason(): string | undefined {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY";
  }
  if (!fs.existsSync(path.join(pkgRoot, "node_modules", ".bin", "electron"))) {
    return "Electron binary not found";
  }
  return undefined;
}

/**
 * Launches the real Electron main process (never a mocked BrowserWindow), sets
 * real content sizes and reads layout metrics from the live page.
 */
async function runHarness(renderer: Renderer, opts: HarnessOptions = {}): Promise<HarnessResult> {
  const reason = skipReason();
  if (reason) return { skipped: reason };

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-window-harness-"));
  const tmpHome = opts.home || makeTempHome("opensand-window-home-");
  const isSelfOwnedHome = !opts.home;
  const runnerScript = path.join(tmpDir, "runner.mjs");
  const mainScript = path.join(pkgRoot, "dist", "src", "main.js");

  const runnerCode = [
    "import { app } from 'electron';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import os from 'node:os';",
    "",
    "const timeout = setTimeout(() => {",
    "  console.error('[runner] Timeout waiting for real-window harness assertions');",
    "  app.quit();",
    "  process.exit(1);",
    "}, 25000);",
    "",
    "async function shot(win, label) {",
    "  const dir = process.env.OPENSAND_HARNESS_SHOT_DIR;",
    "  if (!dir) return;",
    "  fs.mkdirSync(dir, { recursive: true });",
    "  await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');",
    "  await new Promise((r) => setTimeout(r, 150));",
    "  const img = await win.webContents.capturePage();",
    "  const tag = " + JSON.stringify(opts.shotTag || "") + ";",
    "  const fileName = tag",
    "    ? (process.env.OPENSAND_RENDERER || 'default') + '-' + tag + '-' + label + '.png'",
    "    : (process.env.OPENSAND_RENDERER || 'default') + '-' + label + '.png';",
    "  fs.writeFileSync(path.join(dir, fileName), img.toPNG());",
    "}",
    "",
    "const METRICS = `(() => {",
    "  const q = (s) => document.querySelector(s);",
    "  const qAll = (s) => Array.from(document.querySelectorAll(s));",
    "  const rows = qAll('#sessionList .session-channel-item');",
    "  return {",
    "    isElectron: document.body.classList.contains('is-electron'),",
    "    trafficLightClearance: q('.sidebar') ? getComputedStyle(q('.sidebar')).paddingTop : null,",
    "    innerWidth: window.innerWidth,",
    "    scrollWidth: document.documentElement.scrollWidth,",
    "    noOverflow: document.documentElement.scrollWidth <= window.innerWidth,",
    "    hasSidebar: !!q('.sidebar'),",
    "    hasBrandHomeBtn: !!q('.sidebar #brandHomeBtn'),",
    "    hasSessionList: !!q('.sidebar #sessionList'),",
    "    hasSidebarFooter: !!q('.sidebar .sidebar-footer'),",
    "    hasMainPanel: !!q('main.main-panel'),",
    "    hasTopbar: !!q('main.main-panel header.topbar'),",
    "    hasActiveSessionTitle: !!q('main.main-panel #activeSessionTitle'),",
    "    hasViewChat: !!q('#viewChat'),",
    "    hasChatContainer: !!q('#viewChat #chatContainer'),",
    "    hasMessageFeed: !!q('#viewChat #messageFeed'),",
    "    hasInputPanel: !!q('.input-panel'),",
    "    hasPromptInput: !!q('.input-panel #promptInput'),",
    "    hasBtnSend: !!q('.input-panel #btnSend'),",
    "    sidebarWidth: q('.sidebar')?.getBoundingClientRect().width,",
    "    mainWidth: q('main.main-panel')?.getBoundingClientRect().width,",
    "    brandTop: q('#brandHomeBtn')?.getBoundingClientRect().top,",
    "    titleBox: (() => { const r = q('#activeSessionTitle')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; })(),",
    "    titleColor: q('#activeSessionTitle') ? getComputedStyle(q('#activeSessionTitle')).color : null,",
    "    sessionRows: rows.length,",
    "    sessionTitles: rows.map((r) => r.querySelector('.channel-title')?.textContent?.trim() || ''),",
    "    emptyTitle: q('.roster-empty-title')?.textContent?.trim() || null,",
    "    rowOverflow: rows.some((r) => r.scrollWidth > r.clientWidth + 1),",
    "    envHome: window.__OPENSAND_HARNESS_HOME__ || null",
    "  };",
    "})()`;",
    "",
    "// Readiness signal, not a sleep: the renderer adds body.is-electron when app.js runs, and .sidebar",
    "// transitions padding (0.22s), so a read before the class lands, or mid-transition, sees 10px.",
    "const SETTLED = `new Promise((resolve) => {",
    "  const start = Date.now();",
    "  const tick = () => {",
    "    const ready = document.readyState === 'complete' && document.body.classList.contains('is-electron') && document.getAnimations().every((a) => a.playState === 'finished' || a.playState === 'idle');",
    "    if (ready) return requestAnimationFrame(() => resolve(true));",
    "    if (Date.now() - start > 8000) return resolve(false);",
    "    setTimeout(tick, 25);",
    "  };",
    "  tick();",
    "})`;",
    "const settle = async (win) => { if (!(await win.webContents.executeJavaScript(SETTLED))) throw new Error('renderer did not settle (is-electron class and transitions) within 8s'); };",
    "",
    "app.on('browser-window-created', (_event, win) => {",
    "  win.webContents.on('did-finish-load', async () => {",
    "    try {",
    "      await win.webContents.executeJavaScript(`window.__OPENSAND_HARNESS_HOME__ = ${JSON.stringify(process.env.HOME || '')}`);",
    "      await win.webContents.executeJavaScript(`",
    "        new Promise((resolve) => {",
    "          const start = Date.now();",
    "          const check = () => {",
    "            if (document.querySelector('#sessionList .session-channel-item, #sessionList .roster-empty, #sessionList .shell-empty') || Date.now() - start > 3000) {",
    "              resolve();",
    "            } else {",
    "              setTimeout(check, 50);",
    "            }",
    "          };",
    "          check();",
    "        })",
    "      `);",
    "      win.setContentSize(960, 740);",
    "      await settle(win);",
    "      if (process.env.OPENSAND_HARNESS_FORCE_OVERFLOW === '1') {",
    "        await win.webContents.executeJavaScript(\"document.body.insertAdjacentHTML('beforeend', '<div style=\\\"width:3000px;height:4px\\\"></div>')\");",
    "        await new Promise((r) => setTimeout(r, 100));",
    "      }",
    "      await shot(win, '960x740');",
    "      const eval960 = await win.webContents.executeJavaScript(METRICS);",
    "",
    "      win.setContentSize(1920, 1080);",
    "      await settle(win);",
    "      await shot(win, '1920x1080');",
    "      const eval1920 = await win.webContents.executeJavaScript(METRICS);",
    "",
    "      let interactResult = null;",
    "      const extraScript = " + JSON.stringify(opts.interactScript || "") + ";",
    "      if (extraScript) {",
    "        interactResult = await win.webContents.executeJavaScript(extraScript);",
    "      }",
    "",
    "      console.log('__EVAL_960__:' + JSON.stringify(eval960));",
    "      console.log('__EVAL_1920__:' + JSON.stringify(eval1920));",
    "      if (interactResult !== null) {",
    "        console.log('__INTERACT_RESULT__:' + JSON.stringify(interactResult));",
    "      }",
    "      console.log('WINDOW_HARNESS_PASSED');",
    "      clearTimeout(timeout);",
    "      app.quit();",
    "      process.exit(0);",
    "    } catch (err) {",
    "      console.error('[runner] Real-window assertion error:', err);",
    "      clearTimeout(timeout);",
    "      app.quit();",
    "      process.exit(1);",
    "    }",
    "  });",
    "});",
    "",
    "await import(" + JSON.stringify(mainScript) + ");",
  ].join("\n");

  fs.writeFileSync(runnerScript, runnerCode, "utf8");

  try {
    const env = hermeticElectronEnv(tmpHome);
    delete env.OPENSAND_RENDERER;
    if (renderer === "preact") env.OPENSAND_RENDERER = "preact";
    delete env.OPENSAND_HARNESS_FORCE_OVERFLOW;
    if (opts.forceOverflow) {
      env.OPENSAND_HARNESS_FORCE_OVERFLOW = "1";
      delete env.OPENSAND_HARNESS_SHOT_DIR;
    }

    let stdout = "";
    let stderr = "";
    const exitCode = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runnerScript], {
        cwd: pkgRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      return new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? 0));
      });
    });

    assert.strictEqual(
      exitCode,
      0,
      `Electron window harness runner failed with exit code ${exitCode}.\nstdout: ${stdout}\nstderr: ${stderr}`
    );
    assert.match(stdout, /WINDOW_HARNESS_PASSED/, `Expected WINDOW_HARNESS_PASSED in stdout, got:\n${stdout}\nstderr:\n${stderr}`);

    const match960 = stdout.match(/__EVAL_960__:(.*)/);
    const match1920 = stdout.match(/__EVAL_1920__:(.*)/);
    assert.ok(match960, "Output must include __EVAL_960__");
    assert.ok(match1920, "Output must include __EVAL_1920__");

    const res960 = JSON.parse(match960[1]);
    const res1920 = JSON.parse(match1920[1]);

    const resolvedHome = res960.envHome || env.HOME || "";
    assert.ok(resolvedHome, "Hermetic HOME guard: envHome must be non-empty");
    const realTmp = fs.realpathSync(os.tmpdir());
    const realHome = fs.existsSync(resolvedHome) ? fs.realpathSync(resolvedHome) : resolvedHome;
    assert.strictEqual(
      realHome.startsWith(realTmp) || realHome.startsWith("/private" + realTmp),
      true,
      `Hermetic HOME guard failed: baseDir/HOME (${resolvedHome}) must start with os.tmpdir() (${realTmp})`
    );

    let interactResult: any = null;
    const matchInteract = stdout.match(/__INTERACT_RESULT__:(.*)/);
    if (matchInteract) {
      interactResult = JSON.parse(matchInteract[1]);
    }

    if (process.env.OPENSAND_HARNESS_VERBOSE === "1") console.log(`[window-harness.test] ${renderer} 960:`, match960[1]);
    return { res960, res1920, interactResult, home: tmpHome };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (isSelfOwnedHome) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }
}

const forceOverflow = process.env.OPENSAND_HARNESS_FORCE_OVERFLOW === "1";

function assertShellFrame(res960: any, res1920: any): void {
  // 960x740
  assert.strictEqual(res960.isElectron, true, "document.body must have .is-electron class");
  assert.strictEqual(res960.trafficLightClearance, "38px", "Traffic light clearance must be 38px on macOS");
  assert.strictEqual(res960.noOverflow, true, `No horizontal overflow at 960x740: scrollWidth=${res960.scrollWidth}, innerWidth=${res960.innerWidth}`);
  assert.strictEqual(res960.hasSidebar, true, "Aside .sidebar must be present");
  assert.strictEqual(res960.hasBrandHomeBtn, true, ".sidebar #brandHomeBtn must be present");
  assert.strictEqual(res960.hasSessionList, true, ".sidebar #sessionList must be present");
  assert.strictEqual(res960.hasSidebarFooter, true, ".sidebar .sidebar-footer must be present");
  assert.strictEqual(res960.hasMainPanel, true, "main.main-panel must be present");
  assert.strictEqual(res960.hasTopbar, true, "main.main-panel header.topbar must be present");
  assert.strictEqual(res960.hasActiveSessionTitle, true, "main.main-panel #activeSessionTitle must be present");
  // 1920x1080
  assert.strictEqual(res1920.noOverflow, true, `No horizontal overflow at 1920x1080: scrollWidth=${res1920.scrollWidth}, innerWidth=${res1920.innerWidth}`);
  assert.strictEqual(res1920.hasSidebar, true, ".sidebar must remain mounted at 1920x1080");
  assert.strictEqual(res1920.hasMainPanel, true, "main.main-panel must remain mounted at 1920x1080");
  assert.ok(res1920.mainWidth > 1200, `Main content must expand flexibly at full screen (measured ${res1920.mainWidth}px)`);
}

test("Real-Window Harness: default renderer (960x740 and full screen)", async (t) => {
  const r = await runHarness("default", { forceOverflow });
  if (r.skipped) { console.log(`[window-harness.test] ${r.skipped}`); t.skip(r.skipped); return; }
  assertShellFrame(r.res960, r.res1920);
  assert.strictEqual(r.res960.hasViewChat, true, "#viewChat must be present");
  assert.strictEqual(r.res960.hasChatContainer, true, "#viewChat #chatContainer must be present");
  assert.strictEqual(r.res960.hasMessageFeed, true, "#viewChat #messageFeed must be present");
  assert.strictEqual(r.res960.hasInputPanel, true, ".input-panel must be present");
  assert.strictEqual(r.res960.hasPromptInput, true, ".input-panel #promptInput must be present");
  assert.strictEqual(r.res960.hasBtnSend, true, ".input-panel #btnSend must be present");
});

test("Real-Window Harness: Parallel Board mounts independent panes", async (t) => {
  const boardScript = [
    "(async () => {",
    "  document.getElementById('navBtnParallel')?.click();",
    "  await new Promise((r) => setTimeout(r, 250));",
    "  const grid = document.getElementById('parallelGrid');",
    "  const panes = Array.from(grid?.querySelectorAll('.pb-pane') || []);",
    "  const titles = panes.map((p) => p.querySelector('.pb-title')?.textContent || '');",
    "  const inputs = panes.map((p) => !!p.querySelector('.pb-input'));",
    "  document.getElementById('btnParallelAdd')?.click();",
    "  await new Promise((r) => setTimeout(r, 120));",
    "  const afterAdd = grid?.querySelectorAll('.pb-pane').length || 0;",
    "  return {",
    "    visible: !document.getElementById('viewParallel')?.classList.contains('hidden'),",
    "    navExists: !!document.getElementById('navBtnParallel'),",
    "    gridExists: !!grid,",
    "    gridChildren: grid?.children.length || 0,",
    "    paneCount: panes.length,",
    "    distinctTitles: new Set(titles).size,",
    "    allHaveComposers: inputs.every(Boolean),",
    "    afterAdd,",
    "    status: document.getElementById('parallelStatus')?.textContent || '',",
    "  };",
    "})()",
  ].join("\n");

  const r = await runHarness("default", { interactScript: boardScript });
  if (r.skipped) { console.log(`[window-harness.test] ${r.skipped}`); t.skip(r.skipped); return; }
  assert.strictEqual(r.interactResult?.visible, true, "Parallel view must become visible from the footer nav");
  assert.strictEqual(r.interactResult?.paneCount, 2, `Board starts with two independent panes (${JSON.stringify(r.interactResult)})`);
  assert.strictEqual(r.interactResult?.distinctTitles, 2, "Each pane must own a distinct session id");
  assert.strictEqual(r.interactResult?.allHaveComposers, true, "Each pane needs its own prompt input");
  assert.strictEqual(r.interactResult?.afterAdd, 3, "Add button must create a third pane");
  assert.match(r.interactResult?.status || "", /3 pane/, "Status must reflect pane count");
});

test("Real-Window Harness: agent canvas supports focus, minimise, fit and layout persistence", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-canvas-home-"));
  const agentPath = path.join(tmpHome, ".opensand", "agents");
  fs.mkdirSync(agentPath, { recursive: true });
  const now = Date.now();
  for (const [id, name] of [
    ["agent_canvas_alpha_ab12cd34", "Canvas Alpha"],
    ["agent_canvas_beta_ab12cd34", "Canvas Beta"],
  ] as Array<[string, string]>) {
    fs.writeFileSync(path.join(agentPath, `${id}.json`), JSON.stringify({
      id, name, role: "Worker", systemPrompt: "Work.", kind: "AGENT",
      model: "default", provider: "global", createdAt: now, updatedAt: now,
    }), "utf8");
  }

  const script = [
    "(async () => {",
    "  await new Promise((r) => setTimeout(r, 400));",
    "  document.getElementById('navBtnParallel')?.click();",
    "  await new Promise((r) => setTimeout(r, 400));",
    "  const windows = () => Array.from(document.querySelectorAll('#parallelGrid .ag-window'));",
    "  const before = window.__canvasState.getWindows();",
    "  const head = windows()[0]?.querySelector('.ag-head');",
    "  head?.focus();",
    "  head?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));",
    "  const afterMove = window.__canvasState.getWindows()[0];",
    "  windows()[1]?.querySelector('.pb-stream')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));",
    "  const zAfterFocus = Number(getComputedStyle(windows()[1]).zIndex);",
    "  windows()[0]?.querySelector('.ag-min')?.click();",
    "  const minimized = window.__canvasState.getWindows()[0]?.minimized;",
    "  const dockCount = document.querySelectorAll('#canvasDock .canvas-dock-item').length;",
    "  document.querySelector('#canvasDock .canvas-dock-item')?.click();",
    "  const restored = !window.__canvasState.getWindows()[0]?.minimized;",
    "  document.getElementById('btnFitAll')?.click();",
    "  const view = window.__canvasState.getViewport();",
    "  document.getElementById('btnFollowMode')?.click();",
    "  const mode = window.__canvasState.getMode();",
    "  document.getElementById('btnParallelAdd')?.click();",
    "  const count = window.__canvasState.getWindows().length;",
    "  const saved = JSON.parse(localStorage.getItem('opensand.agentCanvas.layout.v1') || '{}');",
    "  windows()[2]?.querySelector('.ag-close')?.click();",
    "  return {",
    "    initialCount: before.length,",
    "    movedX: afterMove.x - before[0].x,",
    "    zAfterFocus,",
    "    minimized, dockCount, restored,",
    "    view, mode, count,",
    "    savedCount: saved.windows?.length || 0,",
    "    finalCount: window.__canvasState.getWindows().length,",
    "  };",
    "})()",
  ].join("\n");

  try {
    const r = await runHarness("default", { home: tmpHome, shotTag: "agent-canvas", interactScript: script });
    if (r.skipped) { t.skip(r.skipped); return; }
    const v = r.interactResult || {};
    assert.strictEqual(v.initialCount, 2, `canvas must start with two windows (${JSON.stringify(v)})`);
    assert.strictEqual(v.movedX, 16, `Alt+Arrow must move a window by 16px (${JSON.stringify(v)})`);
    assert.strictEqual(v.minimized, true, `minimise must hide the window (${JSON.stringify(v)})`);
    assert.strictEqual(v.dockCount, 2, `dock must list every window (${JSON.stringify(v)})`);
    assert.strictEqual(v.restored, true, `dock click must restore the window (${JSON.stringify(v)})`);
    assert.ok(v.view.zoom >= 0.5 && v.view.zoom <= 1, `fit all must clamp zoom (${JSON.stringify(v)})`);
    assert.strictEqual(v.mode, "follow", `mode must toggle (${JSON.stringify(v)})`);
    assert.strictEqual(v.count, 3, `new agent must open a third window (${JSON.stringify(v)})`);
    assert.strictEqual(v.savedCount, 3, `layout must persist after changes (${JSON.stringify(v)})`);
    assert.strictEqual(v.finalCount, 2, `close must remove exactly one window (${JSON.stringify(v)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: per-pane bot selection routes sends and status", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-parallel-bots-home-"));
  const agentPath = path.join(tmpHome, ".opensand", "agents");
  fs.mkdirSync(agentPath, { recursive: true });
  const now = Date.now();
  const alpha = "agent_parallel_alpha_ab12cd34";
  const beta = "agent_parallel_beta_ab12cd34";
  const gamma = "agent_parallel_gamma_ab12cd34";
  for (const [id, name, createdAt] of [
    [alpha, "Parallel Alpha", now + 3000],
    [beta, "Parallel Beta", now + 2000],
    [gamma, "Parallel Gamma", now + 1000],
  ] as Array<[string, string, number]>) {
    fs.writeFileSync(path.join(agentPath, `${id}.json`), JSON.stringify({
      id, name, role: "Worker", systemPrompt: "Work.", kind: "AGENT",
      model: "default", provider: "global", createdAt, updatedAt: createdAt,
    }), "utf8");
  }

  const script = [
    "(async () => {",
    "  await new Promise((r) => setTimeout(r, 350));",
    `  const card = (id) => document.querySelector('#botList .bot-rail-card[data-agent-id="' + id + '"]');`,
    `  card(${JSON.stringify(gamma)})?.click();`,
    "  await new Promise((r) => setTimeout(r, 200));",
    `  window.__railState.emit({ type: 'turn_complete', sessionId: ${JSON.stringify('bot_' + gamma)} });`,
    "  const activeAgentId = window.__railState.getActive().activeAgentId;",
    "  document.getElementById('navBtnParallel')?.click();",
    "  await new Promise((r) => setTimeout(r, 350));",
    "  const panes = Array.from(document.querySelectorAll('#parallelGrid .pb-pane'));",
    "  const selectOpts = Array.from(panes[0].querySelector('.pane-agent').options);",
    "  const options = selectOpts.map((o) => o.value).filter(Boolean);",
    `  const setBot = (pane, id) => { const sel = pane.querySelector('.pane-agent'); sel.value = id; sel.dispatchEvent(new Event('change', { bubbles: true })); };`,
    `  setBot(panes[0], ${JSON.stringify(alpha)});`,
    `  setBot(panes[1], ${JSON.stringify(beta)});`,
    "  const selectValues = panes.map((p) => p.querySelector('.pane-agent').value);",
    "  const send = (pane, text) => { pane.querySelector('.pb-input').value = text; pane.querySelector('.pb-send').click(); };",
    "  send(panes[0], 'alpha turn');",
    "  send(panes[1], 'beta turn');",
    "  await new Promise((r) => setTimeout(r, 250));",
    "  const paneState = window.__parallelState.getPanes();",
    "  const sends = window.__parallelState.getSends();",
    "  window.__railState.emit({ type: 'session_started', sessionId: paneState[0].sessionId });",
    "  const statusFirst = { alpha: card(window.__parallelState.getPanes()[0].agentId)?.dataset.status, active: card(activeAgentId)?.dataset.status };",
    "  window.__railState.emit({ type: 'session_started', sessionId: paneState[1].sessionId });",
    "  const statusSecond = { beta: card(window.__parallelState.getPanes()[1].agentId)?.dataset.status, active: card(activeAgentId)?.dataset.status };",
    "  window.__railState.emit({ type: 'session_started', sessionId: 'bot_' + activeAgentId });",
    "  const activeStatusBefore = card(activeAgentId)?.dataset.status;",
    `  window.__railState.emit({ type: 'turn_complete', sessionId: paneState[0].sessionId });`,
    `  const statusAfterComplete = { alpha: card(${JSON.stringify(alpha)})?.dataset.status, active: card(activeAgentId)?.dataset.status };`,
    "  return { activeAgentId, options, optionCount: selectOpts.length, selectValues, paneState, sends, statusFirst, statusSecond, activeStatusBefore, statusAfterComplete };",
    "})()",
  ].join("\n");

  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: script });
    if (r.skipped) { t.skip(r.skipped); return; }
    const v = r.interactResult || {};
    assert.strictEqual(v.activeAgentId, gamma, `active bot must differ from both pane bots (${JSON.stringify(v)})`);
    assert.strictEqual(v.optionCount, 4, `selector must offer No bot + three seeded agents (${JSON.stringify(v)})`);
    assert.ok(v.options.includes(alpha) && v.options.includes(beta), `selector must list seeded agents (${JSON.stringify(v)})`);
    assert.strictEqual(v.selectValues[0], alpha, `first pane selector must show its own bot (${JSON.stringify(v)})`);
    assert.strictEqual(v.selectValues[1], beta, `second pane selector must show its own bot (${JSON.stringify(v)})`);
    assert.strictEqual(v.paneState[0].agentId, alpha, `first pane must own alpha (${JSON.stringify(v)})`);
    assert.strictEqual(v.paneState[1].agentId, beta, `second pane must own beta (${JSON.stringify(v)})`);
    assert.notStrictEqual(v.paneState[0].sessionId, v.paneState[1].sessionId, "panes must keep distinct session ids");
    const sends = v.sends || [];
    assert.ok(sends.length >= 2, `both panes must have sent (${JSON.stringify(v)})`);
    const alphaSend = sends.find((s: any) => s.sessionId === v.paneState[0].sessionId);
    const betaSend = sends.find((s: any) => s.sessionId === v.paneState[1].sessionId);
    assert.strictEqual(alphaSend?.agentId, alpha, `first pane's sendQuery must carry alpha (${JSON.stringify(v)})`);
    assert.strictEqual(betaSend?.agentId, beta, `second pane's sendQuery must carry beta (${JSON.stringify(v)})`);
    assert.ok(!sends.some((s: any) => s.agentId === v.activeAgentId), "no pane may send with the global active bot");
    assert.strictEqual(v.statusFirst.alpha, "busy", `pane session_started must busy its own bot card (${JSON.stringify(v)})`);
    assert.notStrictEqual(v.statusFirst.active, "busy", `active bot card must stay untouched (${JSON.stringify(v)})`);
    assert.strictEqual(v.statusSecond.beta, "busy", `second pane session_started must busy beta (${JSON.stringify(v)})`);
    assert.notStrictEqual(v.statusSecond.active, "busy", `active bot card must stay untouched after both panes (${JSON.stringify(v)})`);
    assert.strictEqual(v.activeStatusBefore, "busy", `active bot must be busy before pane completion (${JSON.stringify(v)})`);
    assert.strictEqual(v.statusAfterComplete.alpha, "active", `pane turn_complete must clear its own bot's busy status (${JSON.stringify(v)})`);
    assert.strictEqual(v.statusAfterComplete.active, "busy", `pane completion must not spuriously clear the active bot's status (${JSON.stringify(v)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: completion status follows the session owner, not the active bot", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-status-owner-home-"));
  const agentPath = path.join(tmpHome, ".opensand", "agents");
  fs.mkdirSync(agentPath, { recursive: true });
  const now = Date.now();
  const owner = "agent_status_owner_ab12cd34";
  const active = "agent_status_active_ab12cd34";
  for (const [id, name, createdAt] of [
    [owner, "Owner", now + 2000],
    [active, "Active", now + 1000],
  ] as Array<[string, string, number]>) {
    fs.writeFileSync(path.join(agentPath, `${id}.json`), JSON.stringify({
      id, name, role: "Worker", systemPrompt: "Work.", kind: "AGENT",
      model: "default", provider: "global", createdAt, updatedAt: createdAt,
    }), "utf8");
  }

  const script = [
    "(async () => {",
    "  await new Promise((r) => setTimeout(r, 350));",
    `  const card = (id) => document.querySelector('#botList .bot-rail-card[data-agent-id="' + id + '"]');`,
    `  card(${JSON.stringify(active)})?.click();`,
    "  await new Promise((r) => setTimeout(r, 200));",
    `  const activeAgentId = window.__railState.getActive().activeAgentId;`,
    `  window.__railState.emit({ type: 'session_started', sessionId: ${JSON.stringify('bot_' + owner)} });`,
    "  window.__railState.emit({ type: 'session_started', sessionId: 'bot_' + activeAgentId });",
    `  const before = { owner: card(${JSON.stringify(owner)})?.dataset.status, active: card(activeAgentId)?.dataset.status };`,
    `  window.__railState.emit({ type: 'turn_complete', sessionId: ${JSON.stringify('bot_' + owner)} });`,
    `  const after = { owner: card(${JSON.stringify(owner)})?.dataset.status, active: card(activeAgentId)?.dataset.status };`,
    "  return { activeAgentId, before, after };",
    "})()",
  ].join("\n");

  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: script });
    if (r.skipped) { t.skip(r.skipped); return; }
    const v = r.interactResult || {};
    assert.strictEqual(v.activeAgentId, active, `active bot must be the selected bot (${JSON.stringify(v)})`);
    assert.strictEqual(v.before.owner, "busy", `session_started must busy the owner bot (${JSON.stringify(v)})`);
    assert.strictEqual(v.before.active, "busy", `session_started must busy the active bot (${JSON.stringify(v)})`);
    assert.strictEqual(v.after.owner, "active", `turn_complete must clear the session owner's busy status (${JSON.stringify(v)})`);
    assert.strictEqual(v.after.active, "busy", `turn_complete must not clear the active bot's status (${JSON.stringify(v)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: bot card provider chip and model picker", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-bot-card-home-"));
  const agentPath = path.join(tmpHome, ".opensand", "agents");
  fs.mkdirSync(agentPath, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(agentPath, "agent_pickerbot_ab12cd34.json"), JSON.stringify({
    id: "agent_pickerbot_ab12cd34",
    name: "Picker Bot",
    role: "Research Assistant",
    systemPrompt: "You research things.",
    kind: "AGENT",
    model: "bot-model",
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    allowedTools: ["read_file"],
    createdAt: now,
    updatedAt: now,
  }), "utf8");

  const pickerScript = [
    "(async () => {",
    "  await new Promise((r) => setTimeout(r, 350));",
    "  const subs = Array.from(document.querySelectorAll('#botList .bot-item-sub')).map((e) => e.textContent.trim());",
    "  const btn = document.querySelector('#botList .btn-bot-model');",
    "  btn?.click();",
    "  await new Promise((r) => setTimeout(r, 500));",
    "  const pop = document.querySelector('.mp-popover');",
    "  const result = {",
    "    subs,",
    "    avatars: document.querySelectorAll('#botList .bot-avatar').length,",
    "    providerBadges: Array.from(document.querySelectorAll('#botList .bot-provider-badge')).map((e) => e.textContent.trim()),",
    "    statusDots: document.querySelectorAll('#botList .bot-status-dot').length,",
    "    hasPicker: !!pop,",
    "    railGroups: Array.from(pop?.querySelectorAll('.mp-rail-label') || []).map((e) => e.textContent.trim()),",
    "    railCount: pop?.querySelectorAll('.mp-rail-item').length || 0,",
    "    hasSearch: !!pop?.querySelector('.mp-search'),",
    "    source: pop?.querySelector('.mp-source')?.textContent || '',",
    "    hasFollow: !!pop?.querySelector('.mp-follow'),",
    "    saveLabel: pop?.querySelector('.mp-save')?.textContent || '',",
    "  };",
    "  document.querySelector('.mp-backdrop')?.remove();",
    "  return result;",
    "})()",
  ].join("\n");

  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: pickerScript });
    if (r.skipped) { console.log(`[window-harness.test] ${r.skipped}`); t.skip(r.skipped); return; }
    const result = r.interactResult || {};
    assert.ok((result.subs || []).some((c: string) => c.includes('openrouter')), `bot card must show provider in its sub-line (${JSON.stringify(result)})`);
    assert.strictEqual(result.avatars, 1, `exactly one bot card (no Default Assistant row) (${JSON.stringify(result)})`);
    assert.ok((result.providerBadges || []).includes('O'), `bot card needs a provider badge (${JSON.stringify(result)})`);
    assert.strictEqual(result.statusDots, 1, `one bot card needs one status dot (${JSON.stringify(result)})`);
    assert.strictEqual(result.hasPicker, true, `clicking the bot model button must open the picker (${JSON.stringify(result)})`);
    assert.ok(result.railCount >= 3, `provider rail must be populated from the catalog (${JSON.stringify(result)})`);
    assert.ok((result.railGroups || []).length >= 1, `rail must group providers (${JSON.stringify(result)})`);
    assert.strictEqual(result.hasSearch, true, "picker must expose model search");
    assert.strictEqual(result.hasFollow, true, "picker must offer the follow-global choice");
    assert.match(result.saveLabel || '', /Use this model/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: signed-in provider shows a key dot and hides the sign-in hint", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-auth-home-"));
  const credentialDir = path.join(tmpHome, ".opensand", "providers", "grok", "grok");
  fs.mkdirSync(credentialDir, { recursive: true });
  fs.writeFileSync(path.join(credentialDir, "auth.json"), JSON.stringify({ token: "HARNESS_SECRET_NEVER_SHOWN" }), "utf8");
  const agentPath = path.join(tmpHome, ".opensand", "agents");
  fs.mkdirSync(agentPath, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(agentPath, "agent_authbot_ab12cd34.json"), JSON.stringify({
    id: "agent_authbot_ab12cd34",
    name: "Auth Bot",
    role: "Research Assistant",
    systemPrompt: "You research things.",
    kind: "AGENT",
    model: "bot-model",
    provider: "grokAgent",
    allowedTools: ["read_file"],
    createdAt: now,
    updatedAt: now,
  }), "utf8");

  const pickerScript = [
    "(async () => {",
    "  await new Promise((r) => setTimeout(r, 350));",
    "  document.querySelector('#botList .btn-bot-model')?.click();",
    "  await new Promise((r) => setTimeout(r, 500));",
    "  const pop = document.querySelector('.mp-popover');",
    "  const item = pop?.querySelector('[data-provider=\"grokAgent\"]');",
    "  item?.click();",
    "  const result = {",
    "    hasPicker: !!pop,",
    "    hasItem: !!item,",
    "    keyDots: item?.querySelectorAll('.mp-key-dot').length || 0,",
    "    dotTitle: item?.querySelector('.mp-key-dot')?.title || '',",
    "    hasSignInHint: !!pop?.querySelector('.mp-auth-hint'),",
    "    hintText: pop?.querySelector('.mp-auth-hint')?.textContent || '',",
    "    leaksSecret: (pop?.textContent || '').includes('HARNESS_SECRET_NEVER_SHOWN'),",
    "  };",
    "  const unknown = pop?.querySelector('[data-provider=\"copilotAgent\"]');",
    "  unknown?.click();",
    "  result.hasUnknownItem = !!unknown;",
    "  result.unknownKeyDots = unknown?.querySelectorAll('.mp-key-dot').length || 0;",
    "  result.unknownHint = !!pop?.querySelector('.mp-auth-hint');",
    "  document.querySelector('.mp-backdrop')?.remove();",
    "  return result;",
    "})()",
  ].join("\n");

  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: pickerScript });
    if (r.skipped) { console.log(`[window-harness.test] ${r.skipped}`); t.skip(r.skipped); return; }
    const result = r.interactResult || {};
    assert.strictEqual(result.hasPicker, true, `picker must open (${JSON.stringify(result)})`);
    assert.strictEqual(result.hasItem, true, `seeded provider must be in the catalog (${JSON.stringify(result)})`);
    assert.strictEqual(result.keyDots, 1, `signed-in provider must show one key dot (${JSON.stringify(result)})`);
    assert.match(result.dotTitle || '', /sign-out clears the shared/i, `key dot needs a sign-out tooltip (${JSON.stringify(result)})`);
    assert.strictEqual(result.hasSignInHint, false, `signed-in provider must hide the sign-in hint (${JSON.stringify(result)})`);
    assert.strictEqual(result.leaksSecret, false, `credential values must never reach the UI (${JSON.stringify(result)})`);
    assert.strictEqual(result.hasUnknownItem, true, `Copilot-style provider must be in the catalog (${JSON.stringify(result)})`);
    assert.strictEqual(result.unknownKeyDots, 0, `unknown sign-in state must not show a key dot (${JSON.stringify(result)})`);
    assert.strictEqual(result.unknownHint, false, `unknown sign-in state must not show the sign-in hint (${JSON.stringify(result)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: bot settings editor saves provider and model", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-bot-settings-home-"));
  const agentPath = path.join(tmpHome, ".opensand", "agents");
  fs.mkdirSync(agentPath, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(agentPath, "agent_settingsbot_ab12cd34.json"), JSON.stringify({
    id: "agent_settingsbot_ab12cd34",
    name: "Settings Bot",
    role: "Research Assistant",
    systemPrompt: "You research things.",
    kind: "AGENT",
    model: "original-model",
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    allowedTools: ["read_file"],
    createdAt: now,
    updatedAt: now,
  }), "utf8");

  const editorScript = [
    "(async () => {",
    "  await new Promise((r) => setTimeout(r, 350));",
    "  const rows = document.querySelectorAll('#botList .bot-item');",
    "  rows[0]?.click();",
    "  await new Promise((r) => setTimeout(r, 150));",
    "  document.getElementById('btnToggleDetail')?.click();",
    "  await new Promise((r) => setTimeout(r, 450));",
    "  const before = {",
    "    provider: document.getElementById('detailProvider')?.value || '',",
    "    model: document.getElementById('detailModel')?.value || '',",
    "    role: document.getElementById('detailRole')?.value || '',",
    "    sectionVisible: !document.getElementById('detailEngineSection')?.classList.contains('hidden'),",
    "  };",
    "  const model = document.getElementById('detailModel');",
    "  if (model) model.value = 'patched-model-xyz';",
    "  document.getElementById('btnDetailSave')?.click();",
    "  await new Promise((r) => setTimeout(r, 450));",
    "  return { before, after: document.getElementById('detailModel')?.value || '',",
    "    sub: Array.from(document.querySelectorAll('#botList .bot-item-sub')).map((e) => e.textContent.trim()),",
    "  };",
    "})()",
  ].join("\n");

  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: editorScript });
    if (r.skipped) { console.log(`[window-harness.test] ${r.skipped}`); t.skip(r.skipped); return; }
    const result = r.interactResult || {};
    assert.strictEqual(result.before?.provider, 'openrouter', `editor must load the bot provider (${JSON.stringify(result)})`);
    assert.strictEqual(result.before?.model, 'original-model', `editor must load the bot model (${JSON.stringify(result)})`);
    assert.strictEqual(result.before?.sectionVisible, true, "engine section must be visible for a real bot");
    assert.strictEqual(result.after, 'patched-model-xyz', `save must keep the new model (${JSON.stringify(result)})`);
    assert.ok((result.sub || []).some((c: string) => c.includes('patched-model-xyz')), `card sub-line must update after save (${JSON.stringify(result)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: per-bot rail state exposes active session and agent", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-rail-state-home-"));
  const agentPath = path.join(tmpHome, ".opensand", "agents");
  fs.mkdirSync(agentPath, { recursive: true });
  // Seed a persisted bot transcript: opening the delegated session must show
  // both this history and the buffered delegated text (mixed-history fix).
  seedSessions(tmpHome, [{ id: "bot_agent_railbot_ab12cd34", firstLine: "persisted-bot-history" }]);
  const now = Date.now();
  // Canonical bytes from renderer/modules/bot-identity.js iconMarkup('mascot', '#3b82f6', 'neutral').
  // Imported literally because tsc has no allowJs and the source-relative path does not resolve.
  const canonicalMascotSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" data-icon="mascot" data-expression="neutral" stroke="#3b82f6" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><line x1="9" y1="15" x2="15" y2="15"/></svg>';
  const hostileLogoSvg = '<svg onload="window.__pwned=1" data-icon="mascot"></svg>';
  const hostileName = '<img src=x onerror="window.__pwnedImg=1">';
  fs.writeFileSync(path.join(agentPath, "agent_railbot_ab12cd34.json"), JSON.stringify({
    id: "agent_railbot_ab12cd34",
    name: "Rail Bot",
    role: "Research Assistant",
    systemPrompt: "You research things.",
    kind: "AGENT",
    model: "bot-model",
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    allowedTools: ["read_file"],
    logoColor: "#3b82f6",
    logoSvg: canonicalMascotSvg,
    createdAt: now,
    updatedAt: now,
  }), "utf8");
  fs.writeFileSync(path.join(agentPath, "agent_hostile_ab12cd34.json"), JSON.stringify({
    id: "agent_hostile_ab12cd34",
    name: "Hostile Bot",
    role: "Research Assistant",
    systemPrompt: "You research things.",
    kind: "AGENT",
    model: "bot-model",
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    allowedTools: ["read_file"],
    logoColor: "#10b981",
    logoSvg: hostileLogoSvg,
    createdAt: now,
    updatedAt: now,
  }), "utf8");
  fs.writeFileSync(path.join(agentPath, "agent_escaped_ab12cd34.json"), JSON.stringify({
    id: "agent_escaped_ab12cd34",
    name: hostileName,
    role: "Research Assistant",
    systemPrompt: "You research things.",
    kind: "AGENT",
    model: "bot-model",
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    allowedTools: ["read_file"],
    createdAt: now,
    updatedAt: now,
  }), "utf8");

  const railScript = [
    "(async () => {",
    "  await new Promise((r) => setTimeout(r, 350));",
    "  const s = window.__railState;",
    "  const active = s.getActive();",
    "  const canonicalCard = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_railbot_ab12cd34\"]');",
    "  const hostileCard = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_hostile_ab12cd34\"]');",
    "  const escapedCard = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_escaped_ab12cd34\"]');",
    "  const canonicalSvgCount = canonicalCard ? canonicalCard.querySelectorAll('svg').length : -1;",
    "  const canonicalAvatarMascotSvg = canonicalCard ? canonicalCard.querySelectorAll('.bot-avatar svg[data-icon=\"mascot\"]').length : -1;",
    // A rail card always carries a .btn-bot-model spark <svg>; scope the hostile check to the avatar.
    "  const hostileAvatarSvg = hostileCard ? hostileCard.querySelectorAll('.bot-avatar svg').length : -1;",
    "  const hostileInitialTile = hostileCard ? (hostileCard.querySelector('.bot-avatar')?.textContent || '').trim() : null;",
    "  const hostileOnloadCount = hostileCard ? hostileCard.querySelectorAll('[onload]').length : -1;",
    "  const hostileName = " + JSON.stringify(hostileName) + ";",
    "  const escapedNameText = escapedCard ? (escapedCard.querySelector('.bot-item-name')?.textContent || '') : '';",
    "  const escapedNameInDom = escapedNameText.includes(hostileName);",
    "  const escapedImgCount = escapedCard ? escapedCard.querySelectorAll('img').length : -1;",
    "  const escapedOnerrorCount = escapedCard ? escapedCard.querySelectorAll('[onerror]').length : -1;",
    "  const childEvent = (event) => s.emit({ type: 'subagent', sessionId: active.currentSessionId || 'parent-session', subagent: { agentId: 'agent_railbot_ab12cd34', agentName: 'Rail Bot' }, data: { event } });",
    // Progressive text_delta fragments plus the consolidated final answer must
    // NOT both land in the buffer (the double-render regression).
    "  childEvent({ type: 'text_delta', text: 'FRAG_A' });",
    "  childEvent({ type: 'text_delta', text: 'FRAG_B' });",
    "  childEvent({ type: 'turn_completed', finalContent: 'FINAL_ANSWER' });",
    "  const badgeAfterEmit = !!document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_railbot_ab12cd34\"] .delegated-badge');",
    // Capture the buffered text before opening the session drains it.
    "  const buffered = s.buffers.get('bot_agent_railbot_ab12cd34').map((m) => m.content);",
    // A rail re-render must rehydrate the badge from the buffers' unread state.
    "  await s.refresh();",
    "  const badgeAfterRefresh = !!document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_railbot_ab12cd34\"] .delegated-badge');",
    "  const liveCanonicalCard = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_railbot_ab12cd34\"]');",
    "  const parentHasChildText = ['FRAG_A', 'FRAG_B', 'FINAL_ANSWER'].some((t) => document.getElementById('messageFeed').textContent.includes(t));",
    "  const ipcUpdated = await window.opensand.updateAgentSettings('agent_railbot_ab12cd34', { logoColor: '#ef4444' });",
    "  const apiAgents = await (await fetch('/api/agents')).json();",
    "  const apiColor = Array.isArray(apiAgents) ? (apiAgents.find((a) => a.id === 'agent_railbot_ab12cd34') || {}).logoColor : null;",
    // Opening the delegated bot's session last: clears the badge and exposes the active session/agent.
    "  liveCanonicalCard.click();",
    "  await new Promise((r) => setTimeout(r, 250));",
    "  const activeAfterClick = s.getActive();",
    "  const badgeAfterOpen = !!document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_railbot_ab12cd34\"] .delegated-badge');",
    "  const feedText = document.getElementById('messageFeed').textContent;",
    "  const feedHasPersisted = feedText.includes('persisted-bot-history');",
    "  const feedHasDelegated = feedText.includes('FINAL_ANSWER');",
    "  const finalCount = feedText.split('FINAL_ANSWER').length - 1;",
    "  const messageRaw = Array.from(document.querySelectorAll('#messageFeed .message')).map((m) => m._rawContent || '');",
    "  const fragANodes = messageRaw.filter((c) => c.includes('FRAG_A')).length;",
    "  const fragBNodes = messageRaw.filter((c) => c.includes('FRAG_B')).length;",
    "  const finalNodes = messageRaw.filter((c) => c.includes('FINAL_ANSWER')).length;",
    "  const bufferedAfterOpen = s.buffers.get('bot_agent_railbot_ab12cd34').length;",
    // Second injection with the target bot's session now OPEN: a completed turn
    // must render live only, leaving nothing buffered for a later drain.
    "  childEvent({ type: 'turn_completed', finalContent: 'FINAL_LIVE_ONCE' });",
    "  const liveFinalCount = document.getElementById('messageFeed').textContent.split('FINAL_LIVE_ONCE').length - 1;",
    "  const bufferedWhileOpen = s.buffers.get('bot_agent_railbot_ab12cd34').length;",
    "  const badgeWhileOpen = !!document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_railbot_ab12cd34\"] .delegated-badge');",
    // Simulate the selectSession drain: nothing should be pending, and the live
    // answer must still appear exactly once after the drain.
    "  const drainedWhileOpen = s.buffers.drain('bot_agent_railbot_ab12cd34').length;",
    "  const liveFinalCountAfterDrain = document.getElementById('messageFeed').textContent.split('FINAL_LIVE_ONCE').length - 1;",
    "  return {",
    "    hasRailState: !!s,",
    "    hasBuffers: !!(s && s.buffers),",
    "    active: s && typeof s.getActive === 'function' ? s.getActive() : null,",
    "    cards: document.querySelectorAll('#botList .bot-rail-card').length,",
    "    buffered,",
    "    badge: badgeAfterEmit,",
    "    badgeAfterRefresh,",
    "    parentHasChildText,",
    "    canonicalSvgCount,",
    "    canonicalAvatarMascotSvg,",
    "    hostileAvatarSvg,",
    "    hostileInitialTile,",
    "    hostileOnloadCount,",
    "    pwnedIsUndefined: window.__pwned === undefined,",
    "    pwnedImgIsUndefined: window.__pwnedImg === undefined,",
    "    escapedNameInDom,",
    "    escapedImgCount,",
    "    escapedOnerrorCount,",
    "    activeAfterClick,",
    "    ipcColor: ipcUpdated && ipcUpdated.logoColor,",
    "    apiColor,",
    "    badgeAfterOpen,",
    "    feedHasPersisted,",
    "    feedHasDelegated,",
    "    finalCount,",
    "    fragANodes,",
    "    fragBNodes,",
    "    finalNodes,",
    "    bufferedAfterOpen,",
    "    liveFinalCount,",
    "    bufferedWhileOpen,",
    "    badgeWhileOpen,",
    "    drainedWhileOpen,",
    "    liveFinalCountAfterDrain,",
    "  };",
    "})()",
  ].join("\n");

  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: railScript });
    if (r.skipped) { console.log(`[window-harness.test] ${r.skipped}`); t.skip(r.skipped); return; }
    const result = r.interactResult || {};
    assert.strictEqual(result.hasRailState, true, `window.__railState must be installed by the renderer (${JSON.stringify(result)})`);
    assert.strictEqual(result.hasBuffers, true, "rail state must expose per-session buffers");
    assert.ok(result.active && typeof result.active === 'object', "getActive() must return an object");
    assert.ok('currentSessionId' in result.active && 'activeAgentId' in result.active,
      `getActive() must return {currentSessionId, activeAgentId} (${JSON.stringify(result)})`);
    assert.ok((result.buffered || []).includes('FINAL_ANSWER'),
      `consolidated final text must land in the child bot's session buffer (${JSON.stringify(result)})`);
    assert.ok(!(result.buffered || []).some((c: string) => c.includes('FRAG_A') || c.includes('FRAG_B')),
      `text_delta fragments must NOT be buffered alongside the final answer (${JSON.stringify(result)})`);
    assert.strictEqual(result.badge, true, "delegated bot card must show the unread badge");
    assert.strictEqual(result.badgeAfterRefresh, true, `delegated badge must survive a rail re-render/refresh (${JSON.stringify(result)})`);
    assert.strictEqual(result.parentHasChildText, false, "delegated text must not land in the parent feed");
    assert.ok(result.canonicalSvgCount > 0, `canonical-icon bot card must render inline svg (${JSON.stringify(result)})`);
    assert.strictEqual(result.canonicalAvatarMascotSvg, 1,
      `canonical logoSvg must render as the bot avatar (${JSON.stringify(result)})`);
    assert.strictEqual(result.hostileAvatarSvg, 0,
      `hostile logoSvg must not render as inline svg in the avatar (${JSON.stringify(result)})`);
    assert.strictEqual(result.hostileInitialTile, 'H',
      `hostile logoSvg must fall back to an escaped initial tile (${JSON.stringify(result)})`);
    assert.strictEqual(result.hostileOnloadCount, 0, `no [onload] attribute may survive (${JSON.stringify(result)})`);
    assert.strictEqual(result.pwnedIsUndefined, true, `window.__pwned must stay undefined (${JSON.stringify(result)})`);
    assert.strictEqual(result.escapedNameInDom, true, `hostile name must appear as literal text (${JSON.stringify(result)})`);
    assert.strictEqual(result.escapedImgCount, 0, `no <img> element may be created from the name (${JSON.stringify(result)})`);
    assert.strictEqual(result.escapedOnerrorCount, 0, `no [onerror] attribute may survive (${JSON.stringify(result)})`);
    assert.strictEqual(result.pwnedImgIsUndefined, true, `window.__pwnedImg must stay undefined (${JSON.stringify(result)})`);
    assert.ok(result.activeAfterClick && typeof result.activeAfterClick === 'object',
      `getActive() after selecting the bot card must return an object (${JSON.stringify(result)})`);
    assert.strictEqual(result.activeAfterClick?.activeAgentId, 'agent_railbot_ab12cd34',
      `clicking the bot card must select that agent (${JSON.stringify(result)})`);
    assert.strictEqual(result.activeAfterClick?.currentSessionId, 'bot_agent_railbot_ab12cd34',
      `clicking the bot card must open its bot_ session (${JSON.stringify(result)})`);
    assert.strictEqual(result.ipcColor, '#ef4444', `IPC updateAgentSettings must persist the color (${JSON.stringify(result)})`);
    assert.strictEqual(result.apiColor, '#ef4444', `GET /api/agents must reflect the IPC write (${JSON.stringify(result)})`);
    assert.strictEqual(result.badgeAfterOpen, false, `unread badge must clear when the delegated bot's session opens (${JSON.stringify(result)})`);
    assert.strictEqual(result.feedHasPersisted, true, `persisted bot history must survive opening the delegated session (${JSON.stringify(result)})`);
    assert.strictEqual(result.feedHasDelegated, true, `buffered delegated text must be appended to the feed (${JSON.stringify(result)})`);
    assert.strictEqual(result.finalCount, 1, `full final answer must appear exactly ONCE in the feed (${JSON.stringify(result)})`);
    assert.strictEqual(result.finalNodes, 1, `exactly one feed message must carry the final answer (${JSON.stringify(result)})`);
    assert.strictEqual(result.fragANodes, 0, `fragment FRAG_A must NOT appear as its own feed message (${JSON.stringify(result)})`);
    assert.strictEqual(result.fragBNodes, 0, `fragment FRAG_B must NOT appear as its own feed message (${JSON.stringify(result)})`);
    assert.strictEqual(result.bufferedAfterOpen, 0, `drained buffer must be empty after opening the session (${JSON.stringify(result)})`);
    // A turn completing while the target bot is open renders live once and
    // leaves no buffered copy for a later drain to duplicate.
    assert.strictEqual(result.liveFinalCount, 1, `completed turn in the open bot must render live exactly once (${JSON.stringify(result)})`);
    assert.strictEqual(result.bufferedWhileOpen, 0, `completed turn in the open bot must NOT be buffered (${JSON.stringify(result)})`);
    assert.strictEqual(result.badgeWhileOpen, false, `open bot showing output live must carry no delegated badge (${JSON.stringify(result)})`);
    assert.strictEqual(result.drainedWhileOpen, 0, `no buffered text must remain to drain for the open bot (${JSON.stringify(result)})`);
    assert.strictEqual(result.liveFinalCountAfterDrain, 1, `draining after a live render must not duplicate the answer (${JSON.stringify(result)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: delegated results persist and reload without double render", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-delegated-home-"));
  const agentPath = path.join(tmpHome, ".opensand", "agents");
  fs.mkdirSync(agentPath, { recursive: true });
  const targetId = "agent_delegated_ab12cd34";
  const now = Date.now();
  fs.writeFileSync(path.join(agentPath, `${targetId}.json`), JSON.stringify({
    id: targetId,
    name: "Delegate Bot",
    role: "Research Assistant",
    systemPrompt: "You delegate.",
    kind: "AGENT",
    model: "bot-model",
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    allowedTools: [],
    createdAt: now,
    updatedAt: now,
  }), "utf8");
  seedSessions(tmpHome, [{ id: `bot_${targetId}`, firstLine: "persisted-delegated-history" }]);

  const script = [
    "(async () => {",
    "  await new Promise((r) => setTimeout(r, 350));",
    "  const s = window.__railState;",
    "  const parent = s.getActive().currentSessionId || 'parent-session';",
    "  for (const [childId, text] of [['child-A', 'DELEGATED_RESULT_A'], ['child-B', 'DELEGATED_RESULT_B']]) {",
    "    s.emit({ type: 'subagent', sessionId: parent, subagent: { agentId: '" + targetId + "', agentName: 'Delegate Bot', sessionId: childId }, data: { event: { type: 'turn_completed', finalContent: text } } });",
    "  }",
    // Let the async Web Crypto hash + IPC persistence finish before reloading.
    "  await new Promise((r) => setTimeout(r, 400));",
    "  const loaded = await s.loadSession('bot_" + targetId + "');",
    "  const delegated = (loaded.events || []).filter((e) => e.delegated);",
    "  const beforeOpen = {",
    "    count: delegated.length,",
    "    keys: delegated.map((e) => Object.keys(e).sort().join(',')),",
    "    dedupeKeys: delegated.map((e) => e.dedupeKey),",
    "    contents: delegated.map((e) => e.content),",
    "  };",
    // Opening the bot session must render both results from the event log and
    // skip the buffered copies (knownKeys), so each appears exactly once.
    "  const card = document.querySelector('#botList .bot-rail-card[data-agent-id=\"" + targetId + "\"]');",
    "  if (card) card.click();",
    // Poll for both discrete delegated markers rather than relying on a fixed sleep.
    "  const deadline = Date.now() + 2000;",
    "  while (Date.now() < deadline && document.querySelectorAll('#messageFeed .message-delegated-marker').length < 2) {",
    "    await new Promise((r) => setTimeout(r, 50));",
    "  }",
    "  const feed = document.getElementById('messageFeed').textContent;",
    "  return {",
    "    ...beforeOpen,",
    "    hasCard: !!card,",
    "    feedA: feed.split('DELEGATED_RESULT_A').length - 1,",
    "    feedB: feed.split('DELEGATED_RESULT_B').length - 1,",
    "    feedPersisted: feed.includes('persisted-delegated-history'),",
    "    markers: document.querySelectorAll('#messageFeed .message-delegated-marker').length,",
    "    bufferedAfterOpen: s.buffers.get('bot_" + targetId + "').length,",
    "  };",
    "})()",
  ].join("\n");

  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: script });
    if (r.skipped) { console.log(`[window-harness.test] ${r.skipped}`); t.skip(r.skipped); return; }
    const v = r.interactResult || {};
    assert.strictEqual(v.hasCard, true, `target bot card must exist (${JSON.stringify(v)})`);
    assert.strictEqual(v.count, 2, `both delegated results must survive a fresh loadSession (${JSON.stringify(v)})`);
    assert.deepStrictEqual((v.contents || []).sort(), ["DELEGATED_RESULT_A", "DELEGATED_RESULT_B"]);
    assert.ok(v.keys && v.keys.every((k: string) => k === 'content,dedupeKey,delegated,role,timestamp'),
      `delegated events carry the expected keys (${JSON.stringify(v)})`);
    assert.strictEqual(new Set(v.dedupeKeys).size, 2, "distinct children must have distinct dedupe keys");
    assert.ok((v.dedupeKeys || []).every((k: string) => k.includes('|child-')),
      `dedupe keys encode the child session id (${JSON.stringify(v)})`);
    assert.strictEqual(v.feedA, 1, `delegated result A must render exactly once (${JSON.stringify(v)})`);
    assert.strictEqual(v.feedB, 1, `delegated result B must render exactly once (${JSON.stringify(v)})`);
    assert.strictEqual(v.feedPersisted, true, `persisted bot history must still render (${JSON.stringify(v)})`);
    assert.strictEqual(v.markers, 2, `each delegated result must be a discrete, visibly marked message (${JSON.stringify(v)})`);
    assert.strictEqual(v.bufferedAfterOpen, 0, `buffered copies must be drained (${JSON.stringify(v)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: bot roster lives in a persistent sidebar section", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-sidebar-bots-home-"));
  const agentPath = path.join(tmpHome, ".opensand", "agents");
  fs.mkdirSync(agentPath, { recursive: true });
  const now = Date.now();
  // CTO Bot sorts first (listAgents() is newest-first), so ArrowDown has a deterministic target.
  const seededAgents = [
    { id: "agent_railbot_ab12cd34", name: "CTO Bot", provider: "openrouter", model: "cto-model", createdAt: now + 100000 },
    ...Array.from({ length: 7 }, (_, i) => ({
      id: `agent_sidebar_bot_${i + 1}`,
      name: `Bot ${i + 1}`,
      provider: "global",
      model: "default",
      // Bot 1 sorts last so it is hidden by the 6-row cap; readdir order is not reliable.
      createdAt: i === 0 ? now - 7000 : now,
    })),
  ];
  for (const a of seededAgents) {
    fs.writeFileSync(path.join(agentPath, `${a.id}.json`), JSON.stringify({
      id: a.id,
      name: a.name,
      role: "Research Assistant",
      systemPrompt: "You research things.",
      kind: "AGENT",
      model: a.model,
      provider: a.provider,
      createdAt: a.createdAt,
      updatedAt: a.createdAt,
    }), "utf8");
  }
  const script = [
    "(async () => {",
    "  await new Promise((r) => setTimeout(r, 350));",
    "  const list = document.getElementById('botList');",
    "  const section = document.getElementById('botSidecar');",
    "  const nodeBefore = list;",
    "  const chatVisible = !document.getElementById('viewChat').classList.contains('hidden');",
    "  document.getElementById('navBtnBots').click();",
    "  await new Promise((r) => setTimeout(r, 200));",
    "  document.getElementById('btnBackToChat').click();",
    "  await new Promise((r) => setTimeout(r, 250));",
    "  const input = document.getElementById('botSidecarSearch');",
    "  input.value = 'cto';",
    "  input.dispatchEvent(new Event('input', { bubbles: true }));",
    "  const filteredCount = document.querySelectorAll('#botList .bot-rail-card[data-agent-id]').length;",
    "  input.value = '';",
    "  input.dispatchEvent(new Event('input', { bubbles: true }));",
    "  const filterClearedCount = document.querySelectorAll('#botList .bot-rail-card[data-agent-id]').length;",
    "  const moreLabel = document.getElementById('btnBotShowMore').textContent;",
    "  const moreVisible = !document.getElementById('btnBotShowMore').classList.contains('hidden');",
    "  window.__railState.emit({ type: 'subagent', sessionId: 'parent-session', subagent: { agentId: 'agent_sidebar_bot_1', agentName: 'Bot 1' }, data: { event: { type: 'turn_completed', finalContent: 'HIDDEN_DELEGATED' } } });",
    "  await window.__railState.refresh();",
    "  const hiddenCardExists = !!document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_sidebar_bot_1\"]');",
    "  const hiddenBadgeLabel = document.getElementById('btnBotShowMore').textContent;",
    "  document.getElementById('btnBotShowMore').click();",
    "  const expanded = document.querySelectorAll('#botList .bot-rail-card[data-agent-id]').length;",
    "  await window.__railState.refresh();",
    "  const afterRefresh = document.querySelectorAll('#botList .bot-rail-card[data-agent-id]').length;",
    "  const moreLabelAfter = document.getElementById('btnBotShowMore').textContent;",
    "  const card = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_railbot_ab12cd34\"]');",
    "  card.focus();",
    "  const nextFocused = (() => { card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return document.activeElement !== card; })();",
    "  card.focus();",
    "  card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));",
    "  await new Promise((r) => setTimeout(r, 200));",
    "  const kb = window.__railState.getActive();",
    "  window.__railState.emit({ type: 'session_started', sessionId: 'bot_agent_railbot_ab12cd34' });",
    "  const statusAfterEmit = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_railbot_ab12cd34\"]')?.dataset.status;",
    "  input.value = 'zzz-no-match';",
    "  input.dispatchEvent(new Event('input', { bubbles: true }));",
    "  input.value = '';",
    "  input.dispatchEvent(new Event('input', { bubbles: true }));",
    "  const statusAfterFilter = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_railbot_ab12cd34\"]')?.dataset.status;",
    "  const searchFlow = await (async () => {",
    "    const toggle = document.getElementById('btnBotSearch');",
    "    const input = document.getElementById('botSidecarSearch');",
    "    toggle.click();",
    "    const opened = !document.getElementById('botSearchWrap').classList.contains('hidden')",
    "      && document.activeElement === input",
    "      && toggle.getAttribute('aria-expanded') === 'true';",
    "    input.value = 'cto';",
    "    input.dispatchEvent(new Event('input', { bubbles: true }));",
    "    const narrowed = document.querySelectorAll('#botList .bot-rail-card').length;",
    "    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));",
    "    return {",
    "      opened,",
    "      narrowed,",
    "      closed: document.getElementById('botSearchWrap').classList.contains('hidden'),",
    "      focusReturned: document.activeElement === toggle,",
    "      restored: document.querySelectorAll('#botList .bot-rail-card').length,",
    "    };",
    "  })();",
    "  return {",
    "    chatVisible,",
    "    inSection: section?.contains(list) === true,",
    "    sectionInSidebar: !!section?.closest('aside.sidebar'),",
    "    sectionNotInView: !section?.closest('.view-panel'),",
    "    sameNode: document.getElementById('botList') === nodeBefore,",
    "    visible: !!list && !!section && getComputedStyle(section).display !== 'none' && list.getBoundingClientRect().width > 0,",
    "    searchToggle: !!document.getElementById('btnBotSearch'),",
    "    newButton: !!document.getElementById('btnBotNew'),",
    "    moreButton: !!document.getElementById('btnBotShowMore'),",
    "    layout: (() => { const sc = getComputedStyle(section); const rc = getComputedStyle(list); return { display: sc.display, overflow: sc.overflow, railOverflow: rc.overflowY, railMinHeight: rc.minHeight }; })(),",
    "    filteredCount, filterClearedCount, moreLabel, moreVisible, expanded, afterRefresh, moreLabelAfter, nextFocused,",
    "    keyboardSelect: { agent: kb.activeAgentId, session: kb.currentSessionId },",
    "    statusAfterEmit, statusAfterFilter, searchFlow,",
    "    hiddenCardExists, hiddenBadgeLabel,",
    "  };",
    "})()",
  ].join("\n");
  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: script });
    if (r.skipped) { t.skip(r.skipped); return; }
    const v = r.interactResult || {};
    assert.strictEqual(v.chatVisible, true, `chat view must be the boot view (${JSON.stringify(v)})`);
    assert.strictEqual(v.inSection, true, `#botList must live inside #botSidecar (${JSON.stringify(v)})`);
    assert.strictEqual(v.sectionInSidebar, true, `Bots section must be in aside.sidebar (${JSON.stringify(v)})`);
    assert.strictEqual(v.sectionNotInView, true, `Bots section must not be inside a switchable view (${JSON.stringify(v)})`);
    assert.strictEqual(v.sameNode, true, `view switches must not replace #botList (${JSON.stringify(v)})`);
    assert.strictEqual(v.visible, true, `Bots section must be visible in chat view (${JSON.stringify(v)})`);
    assert.strictEqual(v.layout.display, 'flex', `bot section must be a flex column (${JSON.stringify(v)})`);
    assert.strictEqual(v.layout.overflow, 'hidden', `bot section must clip overflow (${JSON.stringify(v)})`);
    assert.strictEqual(v.layout.railOverflow, 'auto', `bot rail must be the scroll container (${JSON.stringify(v)})`);
    assert.strictEqual(v.searchToggle, true, `search toggle must exist (${JSON.stringify(v)})`);
    assert.strictEqual(v.newButton, true, `new-bot button must exist (${JSON.stringify(v)})`);
    assert.strictEqual(v.moreButton, true, `show-more button must exist (${JSON.stringify(v)})`);
    assert.strictEqual(v.filteredCount, 1, `search must narrow cards to the matching bot (${JSON.stringify(v)})`);
    assert.ok(v.filterClearedCount > v.filteredCount, `clearing search must restore cards (${JSON.stringify(v)})`);
    assert.strictEqual(v.moreVisible, true, `show-more must appear when agents exceed the limit (${JSON.stringify(v)})`);
    assert.match(String(v.moreLabel), /Show \d+ more/, `show-more label must count hidden bots (${JSON.stringify(v)})`);
    assert.strictEqual(v.afterRefresh, v.expanded, `expanded state must survive refreshBots() (${JSON.stringify(v)})`);
    assert.match(String(v.moreLabelAfter), /Show less/, `expanded show-more must offer Show less (${JSON.stringify(v)})`);
    assert.strictEqual(v.nextFocused, true, `ArrowDown must move focus to the next card (${JSON.stringify(v)})`);
    assert.strictEqual(v.keyboardSelect.agent, 'agent_railbot_ab12cd34', `Enter must select the focused card (${JSON.stringify(v)})`);
    assert.strictEqual(v.keyboardSelect.session, 'bot_agent_railbot_ab12cd34', `Enter must open the bot_ session (${JSON.stringify(v)})`);
    assert.strictEqual(v.statusAfterEmit, 'busy', `session_started must mark the bot card busy (${JSON.stringify(v)})`);
    assert.strictEqual(v.statusAfterFilter, 'busy', `runtime status must survive a filter re-render (${JSON.stringify(v)})`);
    assert.strictEqual(v.searchFlow.opened, true, `search toggle must open and focus the input (${JSON.stringify(v)})`);
    assert.strictEqual(v.searchFlow.closed, true, `Escape must close search (${JSON.stringify(v)})`);
    assert.strictEqual(v.searchFlow.focusReturned, true, `Escape must return focus to the toggle (${JSON.stringify(v)})`);
    assert.strictEqual(v.searchFlow.restored > v.searchFlow.narrowed, true, `closing search must restore all cards (${JSON.stringify(v)})`);
    assert.strictEqual(v.hiddenCardExists, false, `a hidden bot must not render a card while collapsed (${JSON.stringify(v)})`);
    assert.match(String(v.hiddenBadgeLabel), /1 new/, `show-more must surface unread delegated turns on hidden bots (${JSON.stringify(v)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: chosen chief routes on boot and opens the picker", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-chief-boot-home-"));
  const chiefId = "agent_chief_ab12cd34";
  const opensandDir = path.join(tmpHome, ".opensand");
  const agentPath = path.join(opensandDir, "agents");
  fs.mkdirSync(agentPath, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(agentPath, `${chiefId}.json`), JSON.stringify({
    id: chiefId, name: "Chief Bot", role: "Lead", systemPrompt: "lead",
    kind: "AGENT", model: "default", provider: "global", createdAt: now, updatedAt: now,
  }), "utf8");
  fs.writeFileSync(path.join(opensandDir, "config.json"), JSON.stringify({
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "llama3.1",
    apiKey: "none",
    autoApprove: false,
    provider: "openai",
    theme: "dark",
    chiefOfStaffAgentId: chiefId,
  }), "utf8");

  const script = [
    "(async () => {",
    "  for (let i = 0; i < 40; i++) {",
    "    const a = window.__railState?.getActive();",
    "    if (a && a.activeAgentId === 'agent_chief_ab12cd34' && a.currentSessionId === 'bot_agent_chief_ab12cd34') break;",
    "    await new Promise((r) => setTimeout(r, 100));",
    "  }",
    "  const defaultCard = !!document.querySelector('#botList .bot-rail-card:not([data-agent-id])');",
    "  const active = window.__railState.getActive();",
    "  const badge = document.getElementById('badgeActiveBot').textContent;",
    "  const stateChief = window.__railState.getChiefAgentId();",
    "  const chooseBtn = document.getElementById('btnChooseChief');",
    "  chooseBtn?.click();",
    "  await new Promise((r) => setTimeout(r, 200));",
    "  const picker = document.querySelector('[role=\"dialog\"][aria-label=\"Choose chief of staff\"]');",
    "  const pickerText = picker?.textContent || '';",
    "  const clearButton = !!picker && Array.from(picker.querySelectorAll('button')).some((b) => b.textContent === 'No chief');",
    "  picker?.remove();",
    "  return { defaultCard, active, badge, stateChief, hasChoose: !!chooseBtn, hasPicker: !!picker, pickerText, clearButton };",
    "})()",
  ].join("\n");
  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: script });
    if (r.skipped) { t.skip(r.skipped); return; }
    const v = r.interactResult || {};
    assert.strictEqual(v.defaultCard, false, `no Default Assistant card once a chief is chosen (${JSON.stringify(v)})`);
    assert.strictEqual(v.active?.activeAgentId, chiefId, `boot must activate the chief (${JSON.stringify(v)})`);
    assert.strictEqual(v.active?.currentSessionId, `bot_${chiefId}`, `boot must open the chief's bot_ session (${JSON.stringify(v)})`);
    assert.match(String(v.badge), /Chief Bot/, `badge must show the chief's name (${JSON.stringify(v)})`);
    assert.strictEqual(v.stateChief, chiefId, `renderer must expose the chosen chief (${JSON.stringify(v)})`);
    assert.strictEqual(v.hasChoose, true, `Choose chief button must exist (${JSON.stringify(v)})`);
    assert.strictEqual(v.hasPicker, true, `Choose chief button must open the picker dialog (${JSON.stringify(v)})`);
    assert.match(String(v.pickerText), /Chief Bot/, `picker must list the chief by name (${JSON.stringify(v)})`);
    assert.strictEqual(v.clearButton, true, `picker must offer No chief (${JSON.stringify(v)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: inspector renames and deletes a bot", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-inspector-home-"));
  const agentPath = path.join(tmpHome, ".opensand", "agents");
  fs.mkdirSync(agentPath, { recursive: true });
  seedSessions(tmpHome, [{ id: "bot_agent_insp_a1", firstLine: "bot-home-history" }]);
  const now = Date.now();
  for (const [id, name] of [["agent_insp_a1", "Alpha Bot"], ["agent_insp_b2", "Beta Bot"]] as const) {
    fs.writeFileSync(path.join(agentPath, `${id}.json`), JSON.stringify({
      id, name, role: "Tester", systemPrompt: `You are ${name}.`, kind: "AGENT",
      model: "default", provider: "global", createdAt: now, updatedAt: now,
    }), "utf8");
  }
  const script = [
    "(async () => {",
    "  await new Promise((r) => setTimeout(r, 350));",
    "  const card = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_insp_a1\"]');",
    "  const btn = card.querySelector('.btn-bot-inspect');",
    "  btn.click();",
    "  await new Promise((r) => setTimeout(r, 150));",
    "  const dialog = document.querySelector('.inspector-popover');",
    "  const cards = dialog ? dialog.querySelectorAll('.inspector-card').length : -1;",
    "  const input = dialog?.querySelector('.inspector-name');",
    "  input.value = 'Renamed Alpha';",
    "  dialog.querySelector('.inspector-rename').click();",
    "  let renamed = null;",
    "  let cardName = null;",
    "  for (let i = 0; i < 20; i++) {",
    "    const agents = await (await fetch('/api/agents')).json();",
    "    renamed = (agents || []).find((a) => a.id === 'agent_insp_a1')?.name;",
    "    cardName = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_insp_a1\"] .bot-item-name')?.textContent;",
    "    if (renamed === 'Renamed Alpha' && cardName === 'Renamed Alpha') break;",
    "    await new Promise((r) => setTimeout(r, 100));",
    "  }",
    "  const focusAfterRename = document.activeElement?.classList?.contains('btn-bot-inspect') === true;",
    "  const alphaCard = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_insp_a1\"]');",
    "  alphaCard.querySelector('.btn-bot-inspect').click();",
    "  await new Promise((r) => setTimeout(r, 150));",
    "  const alphaSessionRows = [...document.querySelectorAll('.inspector-popover .inspector-session')];",
    "  const alphaSessionLabels = alphaSessionRows.map((r) => r.textContent);",
    "  alphaSessionRows[0]?.click();",
    "  await new Promise((r) => setTimeout(r, 250));",
    "  const openedSession = window.__railState.getActive().currentSessionId;",
    "  const sessionsBtn = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_insp_b2\"] .btn-bot-inspect');",
    "  sessionsBtn.click();",
    "  await new Promise((r) => setTimeout(r, 150));",
    "  const betaSessionRows = document.querySelectorAll('.inspector-popover .inspector-session').length;",
    "  window.confirm = () => true;",
    "  const betaDialog = document.querySelector('.inspector-popover');",
    "  betaDialog.querySelector('.inspector-delete').click();",
    "  let betaGone = false;",
    "  let betaCardGone = false;",
    "  for (let i = 0; i < 20; i++) {",
    "    const remaining = await (await fetch('/api/agents')).json();",
    "    betaGone = !(remaining || []).some((a) => a.id === 'agent_insp_b2');",
    "    betaCardGone = !document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_insp_b2\"]');",
    "    if (betaGone && betaCardGone) break;",
    "    await new Promise((r) => setTimeout(r, 100));",
    "  }",
    "  return { cards, renamed, cardName, focusAfterRename, alphaSessionRowCount: alphaSessionRows.length, alphaSessionLabels, openedSession, betaSessionRows, betaGone, betaCardGone };",
    "})()",
  ].join("\n");
  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: script });
    if (r.skipped) { t.skip(r.skipped); return; }
    const v = r.interactResult || {};
    assert.strictEqual(v.cards, 2, `inspector must have manage + sessions cards (${JSON.stringify(v)})`);
    assert.strictEqual(v.renamed, "Renamed Alpha", `rename must persist via API (${JSON.stringify(v)})`);
    assert.strictEqual(v.cardName, "Renamed Alpha", `rail must show the new name (${JSON.stringify(v)})`);
    assert.strictEqual(v.focusAfterRename, true, `focus must return to the re-rendered inspect button after rename (${JSON.stringify(v)})`);
    assert.strictEqual(v.alphaSessionRowCount, 1, `one bot home session must be listed once (${JSON.stringify(v)})`);
    assert.match(String(v.alphaSessionLabels[0]), /bot-home-history/, `the REAL session row must be listed, not the synthetic home (${JSON.stringify(v)})`);
    assert.strictEqual(v.openedSession, "bot_agent_insp_a1", `clicking a session must open it (${JSON.stringify(v)})`);
    assert.strictEqual(v.betaSessionRows, 1, `a bot with no real sessions shows exactly one synthetic home row (${JSON.stringify(v)})`);
    assert.strictEqual(v.betaGone, true, `delete must remove the agent from the API (${JSON.stringify(v)})`);
    assert.strictEqual(v.betaCardGone, true, `delete must remove the rail card (${JSON.stringify(v)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: nested bot tree, dedupe and inspector chief", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-tree-home-"));
  const chiefId = "agent_tree_chief";
  const workerId = "agent_tree_worker";
  const opensandDir = path.join(tmpHome, ".opensand");
  const agentPath = path.join(opensandDir, "agents");
  fs.mkdirSync(agentPath, { recursive: true });
  const now = Date.now();
  for (const [id, name] of [[chiefId, "Chief Bot"], [workerId, "Worker Bot"]] as const) {
    fs.writeFileSync(path.join(agentPath, `${id}.json`), JSON.stringify({
      id, name, role: "Tester", systemPrompt: `You are ${name}.`, kind: "AGENT",
      model: "default", provider: "global", createdAt: now, updatedAt: now,
    }), "utf8");
  }
  fs.writeFileSync(path.join(opensandDir, "config.json"), JSON.stringify({
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "llama3.1",
    apiKey: "none",
    autoApprove: false,
    provider: "openai",
    theme: "dark",
    chiefOfStaffAgentId: chiefId,
  }), "utf8");
  seedSessions(tmpHome, [
    { id: `bot_${chiefId}`, firstLine: "chief home" },
    { id: "sess_tree_chief", firstLine: "chief task" },
    { id: `bot_${workerId}`, firstLine: "worker home" },
    { id: "sess_tree_worker", firstLine: "worker task" },
    { id: "sess_tree_orphan", firstLine: "orphan chat" },
  ]);
  for (const [session, agentId] of [["sess_tree_chief", chiefId], ["sess_tree_worker", workerId]] as const) {
    fs.writeFileSync(path.join(opensandDir, "sessions", session, "meta.json"), JSON.stringify({ agentId }), "utf8");
  }

  const script = [
    "(async () => {",
    "  const wait = async (fn, ms = 4000) => { const start = Date.now(); while (Date.now() - start < ms) { const value = fn(); if (value) return value; await new Promise((r) => setTimeout(r, 50)); } return fn(); };",
    "  await wait(() => document.querySelectorAll('#botList .bot-rail-card').length >= 2);",
    "  await new Promise((r) => setTimeout(r, 400));",
    "  const cardCount = document.querySelectorAll('#botList .bot-rail-card').length;",
    "  const noDefaultCard = !document.querySelector('#botList .bot-rail-card:not([data-agent-id])');",
    "  const toggleCount = document.querySelectorAll('#botList .bot-tree-toggle').length;",
    "  const findCard = (id) => document.querySelector(`#botList .bot-rail-card[data-agent-id='${id}']`);",
    "  const findGroup = (id) => findCard(id)?.parentElement.querySelector('.bot-session-group');",
    "  const findToggle = (id) => findCard(id)?.parentElement.querySelector('.bot-tree-toggle');",
    "  const chiefBadge = !!findCard('agent_tree_chief')?.querySelector('.bot-chief-badge');",
    "  const beforeExpanded = findToggle('agent_tree_worker')?.getAttribute('aria-expanded');",
    "  const beforeHidden = findGroup('agent_tree_worker')?.hidden;",
    "  const beforeRows = findGroup('agent_tree_worker')?.querySelectorAll('.bot-session-row').length || 0;",
    "  findToggle('agent_tree_worker')?.click();",
    "  await new Promise((r) => setTimeout(r, 120));",
    "  const toggleFocused = document.activeElement?.classList?.contains('bot-tree-toggle') === true;",
    "  const rowAriaLabels = [...(findGroup('agent_tree_worker')?.querySelectorAll('.bot-session-row') || [])].map((r) => r.getAttribute('aria-label'));",
    "  const afterExpanded = findToggle('agent_tree_worker')?.getAttribute('aria-expanded');",
    "  const afterHidden = findGroup('agent_tree_worker')?.hidden;",
    "  const rowIds = [...(findGroup('agent_tree_worker')?.querySelectorAll('.bot-session-row') || [])].map((r) => r.dataset.sessionId);",
    "  const storedExpanded = localStorage.getItem('opensand-bot-tree-expanded');",
    "  const targetRow = [...(findGroup('agent_tree_worker')?.querySelectorAll('.bot-session-row') || [])].find((r) => r.dataset.sessionId === 'sess_tree_worker');",
    "  targetRow?.click();",
    "  await new Promise((r) => setTimeout(r, 250));",
    "  const activeAfterOpen = window.__railState.getActive();",
    "  await window.__railState.refresh();",
    "  await new Promise((r) => setTimeout(r, 100));",
    "  const persistedExpanded = findToggle('agent_tree_worker')?.getAttribute('aria-expanded');",
    "  const persistedHidden = findGroup('agent_tree_worker')?.hidden;",
    "  const globalIds = [...document.querySelectorAll('#sessionList .session-channel-item .btn-delete-session')].map((b) => b.dataset.sessionId);",
    "  window.confirm = () => true;",
    "  const delBtn = findGroup('agent_tree_worker')?.querySelector('.btn-delete-session[data-session-id=\"sess_tree_worker\"]');",
    "  delBtn?.click();",
    "  let sessionGone = false;",
    "  for (let i = 0; i < 30; i++) {",
    "    const all = await (await fetch('/api/sessions')).json();",
    "    sessionGone = !(all || []).some((s) => s.id === 'sess_tree_worker');",
    "    if (sessionGone) break;",
    "    await new Promise((r) => setTimeout(r, 100));",
    "  }",
    "  let rowAfterDelete = [];",
    "  let focusAfterDelete = false;",
    "  for (let i = 0; i < 30; i++) {",
    "    rowAfterDelete = [...(findGroup('agent_tree_worker')?.querySelectorAll('.bot-session-row') || [])].map((r) => r.dataset.sessionId);",
    "    focusAfterDelete = document.activeElement?.classList?.contains('btn-bot-inspect') === true;",
    "    if (!rowAfterDelete.includes('sess_tree_worker') && focusAfterDelete) break;",
    "    await new Promise((r) => setTimeout(r, 100));",
    "  }",
    "  findCard('agent_tree_chief')?.querySelector('.btn-bot-inspect')?.click();",
    "  await new Promise((r) => setTimeout(r, 150));",
    "  const chiefButtons = [...document.querySelectorAll('.inspector-popover .inspector-chief')].map((b) => b.textContent);",
    "  const clearBtn = [...document.querySelectorAll('.inspector-popover .inspector-chief')].find((b) => b.textContent === 'Clear chief');",
    "  clearBtn?.click();",
    "  await new Promise((r) => setTimeout(r, 300));",
    "  const stateAfterClear = window.__railState.getChiefAgentId();",
    "  const badgeAfterClear = document.getElementById('badgeActiveBot').textContent;",
    "  const focusAfterClearChief = document.activeElement?.classList?.contains('btn-bot-inspect') === true;",
    "  findCard('agent_tree_worker')?.querySelector('.btn-bot-inspect')?.click();",
    "  await new Promise((r) => setTimeout(r, 150));",
    "  const workerButtons = [...document.querySelectorAll('.inspector-popover .inspector-chief')].map((b) => b.textContent);",
    "  const setBtn = [...document.querySelectorAll('.inspector-popover .inspector-chief')].find((b) => b.textContent === 'Set as chief');",
    "  setBtn?.click();",
    "  await new Promise((r) => setTimeout(r, 400));",
    "  const stateAfterSet = window.__railState.getChiefAgentId();",
    "  const workerChiefBadge = !!findCard('agent_tree_worker')?.querySelector('.bot-chief-badge');",
    "  const focusAfterSetChief = document.activeElement?.classList?.contains('btn-bot-inspect') === true;",
    "  return { cardCount, noDefaultCard, toggleCount, chiefBadge, beforeExpanded, beforeHidden, beforeRows, toggleFocused, rowAriaLabels, afterExpanded, afterHidden, rowIds, storedExpanded, activeAfterOpen, persistedExpanded, persistedHidden, globalIds, sessionGone, rowAfterDelete, focusAfterDelete, chiefButtons, stateAfterClear, badgeAfterClear, focusAfterClearChief, workerButtons, stateAfterSet, workerChiefBadge, focusAfterSetChief };",
    "})()",
  ].join("\n");
  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: script });
    if (r.skipped) { t.skip(r.skipped); return; }
    const v = r.interactResult || {};
    assert.strictEqual(v.cardCount, 2, `one card per bot, no default row (${JSON.stringify(v)})`);
    assert.strictEqual(v.noDefaultCard, true, `no Default Assistant card must exist (${JSON.stringify(v)})`);
    assert.strictEqual(v.toggleCount, 2, `one disclosure per bot (${JSON.stringify(v)})`);
    assert.strictEqual(v.chiefBadge, true, `chief row must carry the ★ chief badge (${JSON.stringify(v)})`);
    assert.strictEqual(v.beforeExpanded, "false", `disclosure starts collapsed (${JSON.stringify(v)})`);
    assert.strictEqual(v.beforeHidden, true, `nested group starts hidden (${JSON.stringify(v)})`);
    assert.strictEqual(v.beforeRows, 2, `worker homepage + one real session are nested even when hidden (${JSON.stringify(v)})`);
    assert.strictEqual(v.toggleFocused, true, `disclosure focus must survive the re-render (${JSON.stringify(v)})`);
    assert.ok(v.rowAriaLabels.every((label: string) => / session$/.test(label)), `nested rows need a descriptive aria-label (${JSON.stringify(v)})`);
    assert.strictEqual(v.afterExpanded, "true", `disclosure click flips aria-expanded (${JSON.stringify(v)})`);
    assert.strictEqual(v.afterHidden, false, `disclosure click reveals the nested group (${JSON.stringify(v)})`);
    assert.ok(v.rowIds.includes("bot_agent_tree_worker") && v.rowIds.includes("sess_tree_worker"), `nested rows must include the home and owned session (${JSON.stringify(v)})`);
    assert.match(String(v.storedExpanded), /agent_tree_worker/, `expanded id must persist to localStorage (${JSON.stringify(v)})`);
    assert.strictEqual(v.activeAfterOpen?.currentSessionId, "sess_tree_worker", `nested row must open that session (${JSON.stringify(v)})`);
    assert.strictEqual(v.activeAfterOpen?.activeAgentId, workerId, `nested row must activate the owning bot (${JSON.stringify(v)})`);
    assert.strictEqual(v.persistedExpanded, "true", `expanded state must survive refreshBots() (${JSON.stringify(v)})`);
    assert.strictEqual(v.persistedHidden, false, `nested group must stay revealed after refreshBots() (${JSON.stringify(v)})`);
    assert.strictEqual(v.globalIds.includes("sess_tree_worker"), false, `global roster must not duplicate bot-owned sessions (${JSON.stringify(v)})`);
    assert.strictEqual(v.globalIds.includes("bot_agent_tree_worker"), false, `global roster must not duplicate the bot home session (${JSON.stringify(v)})`);
    assert.strictEqual(v.globalIds.includes("sess_tree_orphan"), true, `orphan sessions must remain in the global roster (${JSON.stringify(v)})`);
    assert.strictEqual(v.sessionGone, true, `nested delete must remove the session via the API (${JSON.stringify(v)})`);
    assert.strictEqual(v.rowAfterDelete.includes("sess_tree_worker"), false, `nested delete must drop the row (${JSON.stringify(v)})`);
    assert.strictEqual(v.focusAfterDelete, true, `nested delete must restore focus to the bot card (${JSON.stringify(v)})`);
    assert.ok(v.chiefButtons.includes("Clear chief"), `inspector of the chief must offer Clear chief (${JSON.stringify(v)})`);
    assert.strictEqual(v.stateAfterClear ?? null, null, `Clear chief must reset the renderer's chief id (${JSON.stringify(v)})`);
    assert.match(String(v.badgeAfterClear), /No chief chosen/, `clearing chief must reset the badge (${JSON.stringify(v)})`);
    assert.strictEqual(v.focusAfterClearChief, true, `Clear chief must restore focus to the re-rendered inspect button (${JSON.stringify(v)})`);
    assert.ok(v.workerButtons.includes("Set as chief"), `inspector of a non-chief must offer Set as chief (${JSON.stringify(v)})`);
    assert.strictEqual(v.stateAfterSet, workerId, `Set as chief must update the renderer's chief id (${JSON.stringify(v)})`);
    assert.strictEqual(v.workerChiefBadge, true, `new chief must gain the badge without a reload (${JSON.stringify(v)})`);
    assert.strictEqual(v.focusAfterSetChief, true, `Set chief must restore focus to the re-rendered inspect button (${JSON.stringify(v)})`);
    // REST settings read a separate cached bridge instance, so verify the
    // persisted file directly (the renderer's IPC state is asserted above).
    const persisted = JSON.parse(fs.readFileSync(path.join(tmpHome, ".opensand", "config.json"), "utf8"));
    assert.strictEqual(persisted.chiefOfStaffAgentId, workerId, `Set as chief must persist to config.json (${JSON.stringify(v)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: sessions of collapsed bots stay in the global roster", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-stranded-home-"));
  const ids = Array.from({ length: 8 }, (_, i) => `agent_hidden_${i + 1}`);
  const opensandDir = path.join(tmpHome, ".opensand");
  const agentPath = path.join(opensandDir, "agents");
  fs.mkdirSync(agentPath, { recursive: true });
  const now = Date.now();
  for (const [i, id] of ids.entries()) {
    fs.writeFileSync(path.join(agentPath, `${id}.json`), JSON.stringify({
      id, name: `Hidden Bot ${i + 1}`, role: "Tester", systemPrompt: "test", kind: "AGENT",
      model: "default", provider: "global", createdAt: now + i, updatedAt: now + i,
    }), "utf8");
  }
  fs.writeFileSync(path.join(opensandDir, "config.json"), JSON.stringify({
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "llama3.1",
    apiKey: "none",
    autoApprove: false,
    provider: "openai",
    theme: "dark",
  }), "utf8");
  seedSessions(tmpHome, ids.map((id) => ({ id: `bot_${id}`, firstLine: `history of ${id}` })));

  const script = [
    "(async () => {",
    "  const allIds = " + JSON.stringify(ids) + ";",
    "  const start = Date.now();",
    "  while (document.querySelectorAll('#botList .bot-rail-card').length < 6 && Date.now() - start < 4000) await new Promise((r) => setTimeout(r, 50));",
    "  const shownIds = [...document.querySelectorAll('#botList .bot-rail-card')].map((c) => c.dataset.agentId);",
    "  const globalIds = [...document.querySelectorAll('#sessionList .session-channel-item .btn-delete-session')].map((b) => b.dataset.sessionId);",
    "  const hiddenIds = allIds.filter((id) => !shownIds.includes(id));",
    "  const stranded = hiddenIds.filter((id) => globalIds.includes('bot_' + id));",
    "  const duplicatedShown = shownIds.filter((id) => globalIds.includes('bot_' + id));",
    "  const moreVisible = !document.getElementById('btnBotShowMore')?.classList.contains('hidden');",
    "  document.getElementById('btnBotShowMore')?.click();",
    "  let expandedShownIds = [];",
    "  for (let i = 0; i < 40; i++) {",
    "    expandedShownIds = [...document.querySelectorAll('#botList .bot-rail-card')].map((c) => c.dataset.agentId);",
    "    if (expandedShownIds.length === allIds.length) break;",
    "    await new Promise((r) => setTimeout(r, 50));",
    "  }",
    "  let expandedGlobalIds = [];",
    "  for (let i = 0; i < 40; i++) {",
    "    expandedGlobalIds = [...document.querySelectorAll('#sessionList .session-channel-item .btn-delete-session')].map((b) => b.dataset.sessionId);",
    "    if (!expandedGlobalIds.includes('bot_' + hiddenIds[0])) break;",
    "    await new Promise((r) => setTimeout(r, 50));",
    "  }",
    "  const duplicatesAfterExpand = expandedShownIds.filter((id) => expandedGlobalIds.includes('bot_' + id));",
    "  const search = document.getElementById('botSidecarSearch');",
    "  search.value = 'Hidden Bot 1';",
    "  search.dispatchEvent(new Event('input', { bubbles: true }));",
    "  let filteredShownIds = [];",
    "  for (let i = 0; i < 40; i++) {",
    "    filteredShownIds = [...document.querySelectorAll('#botList .bot-rail-card')].map((c) => c.dataset.agentId);",
    "    if (filteredShownIds.length === 1) break;",
    "    await new Promise((r) => setTimeout(r, 50));",
    "  }",
    "  let filteredGlobalIds = [];",
    "  for (let i = 0; i < 40; i++) {",
    "    filteredGlobalIds = [...document.querySelectorAll('#sessionList .session-channel-item .btn-delete-session')].map((b) => b.dataset.sessionId);",
    "    if (filteredGlobalIds.includes('bot_' + hiddenIds[0])) break;",
    "    await new Promise((r) => setTimeout(r, 50));",
    "  }",
    "  const filteredHiddenVisible = hiddenIds.filter((id) => filteredGlobalIds.includes('bot_' + id));",
    "  const filteredDuplicate = filteredShownIds.filter((id) => filteredGlobalIds.includes('bot_' + id));",
    "  return { cardCount: shownIds.length, moreVisible, hiddenIds, stranded, duplicatedShown, globalCount: globalIds.length, expandedShownIds, duplicatesAfterExpand, filteredShownIds, filteredHiddenVisible, filteredDuplicate, filteredGlobalCount: filteredGlobalIds.length };",
    "})()",
  ].join("\n");
  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: script });
    if (r.skipped) { t.skip(r.skipped); return; }
    const v = r.interactResult || {};
    assert.strictEqual(v.cardCount, 6, `collapsed rail shows six bots (${JSON.stringify(v)})`);
    assert.strictEqual(v.moreVisible, true, `show-more must expose the hidden bots (${JSON.stringify(v)})`);
    assert.strictEqual(v.hiddenIds?.length, 2, `two bots must be outside the collapsed view (${JSON.stringify(v)})`);
    assert.ok(v.stranded.length >= 1, `a hidden bot's session must stay reachable in #sessionList (${JSON.stringify(v)})`);
    assert.strictEqual(v.duplicatedShown.length, 0, `visible bots' sessions must still be deduped (${JSON.stringify(v)})`);
    assert.strictEqual(v.expandedShownIds?.length, 8, `Show more must render all eight bots (${JSON.stringify(v)})`);
    assert.strictEqual(v.duplicatesAfterExpand.length, 0, `Show more must remove now-shown bots' sessions from #sessionList (${JSON.stringify(v)})`);
    assert.strictEqual(v.filteredShownIds?.length, 1, `bot search must narrow the rail to one bot (${JSON.stringify(v)})`);
    assert.ok(v.filteredHiddenVisible.length >= 1, `filtering out a bot must restore its bot_ session in #sessionList (${JSON.stringify(v)})`);
    assert.strictEqual(v.filteredDuplicate.length, 0, `the still-shown bot must stay deduped after filtering (${JSON.stringify(v)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: Preact shell frame seeded sessions & search (960x740 and 1920x1080)", async (t) => {
  const built = fs.existsSync(path.join(pkgRoot, "dist", "renderer-next", "index.html"));
  if (!built) {
    t.skip("dist/renderer-next is not built (run pnpm build)");
    return;
  }

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-p5b-seeded-"));
  try {
    const longFirstLine = "A".repeat(200);
    seedSessions(tmpHome, [
      { id: "sess-1", firstLine: "Alpha robotics exploration", mtime: new Date("2026-06-01T12:00:00Z") },
      { id: "sess-2", firstLine: "Beta query matching needle", mtime: new Date("2026-05-01T12:00:00Z") },
      { id: "sess-3", firstLine: longFirstLine, mtime: new Date("2026-04-01T12:00:00Z") },
    ]);

    const searchScript = [
      "(async () => {",
      "  const input = document.querySelector('#conversationSearchInput');",
      "  input.value = 'needle';",
      "  input.dispatchEvent(new Event('input', { bubbles: true }));",
      "  await new Promise((r) => setTimeout(r, 250));",
      "  const qAll = (s) => Array.from(document.querySelectorAll(s));",
      "  const matchRows = qAll('#sessionList .session-channel-item').length;",
      "  const matchTitles = qAll('#sessionList .session-channel-item .channel-title').map((e) => e.textContent.trim());",
      "",
      "  input.value = 'nonexistent_query_xyz';",
      "  input.dispatchEvent(new Event('input', { bubbles: true }));",
      "  await new Promise((r) => setTimeout(r, 250));",
      "  const noMatchRows = qAll('#sessionList .session-channel-item').length;",
      "  const noMatchEmptyTitle = document.querySelector('.roster-empty-title')?.textContent.trim() || null;",
      "",
      "  return { matchRows, matchTitles, noMatchRows, noMatchEmptyTitle };",
      "})()",
    ].join("\n");

    const r = await runHarness("preact", {
      home: tmpHome,
      shotTag: "seeded",
      interactScript: searchScript,
      forceOverflow,
    });
    if (r.skipped) { console.log(`[window-harness.test] ${r.skipped}`); t.skip(r.skipped); return; }

    assertShellFrame(r.res960, r.res1920);
    assert.strictEqual(r.res960.hasViewChat, false, "Preact shell must not be the legacy DOM");

    // (a) three seeded sessions -> 3 rows, titles in mtime-descending order, 200-char truncated to 40 chars
    assert.strictEqual(r.res960.sessionRows, 3, "Expected 3 session rows at 960x740");
    assert.deepStrictEqual(r.res960.sessionTitles, [
      "Alpha robotics exploration",
      "Beta query matching needle",
      "A".repeat(40),
    ]);
    assert.strictEqual(r.res960.noOverflow, true, "No horizontal overflow at 960x740");
    assert.strictEqual(r.res960.rowOverflow, false, "No row overflow with 200-char seeded title at 960x740");
    assert.ok(r.res960.sidebarWidth >= 240 && r.res960.sidebarWidth <= 280, `Sidebar width within 240-280px (got ${r.res960.sidebarWidth})`);

    // 1920x1080 dimensions
    assert.strictEqual(r.res1920.sessionRows, 3, "Expected 3 session rows at 1920x1080");
    assert.deepStrictEqual(r.res1920.sessionTitles, [
      "Alpha robotics exploration",
      "Beta query matching needle",
      "A".repeat(40),
    ]);
    assert.strictEqual(r.res1920.noOverflow, true, "No horizontal overflow at 1920x1080");
    assert.strictEqual(r.res1920.rowOverflow, false, "No row overflow with 200-char seeded title at 1920x1080");
    assert.ok(r.res1920.sidebarWidth >= 240 && r.res1920.sidebarWidth <= 280, `Sidebar width within 240-280px (got ${r.res1920.sidebarWidth})`);

    // (c) search interaction assertions
    assert.ok(r.interactResult, "Expected interactResult from search test");
    assert.strictEqual(r.interactResult.matchRows, 1, "Matching query must return exactly 1 row");
    assert.strictEqual(r.interactResult.matchTitles[0], "Beta query matching needle");
    assert.strictEqual(r.interactResult.noMatchRows, 0, "Non-matching query must return 0 rows");
    assert.strictEqual(r.interactResult.noMatchEmptyTitle, "No conversations match");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: Preact empty home state (960x740 and 1920x1080)", async (t) => {
  const built = fs.existsSync(path.join(pkgRoot, "dist", "renderer-next", "index.html"));
  if (!built) {
    t.skip("dist/renderer-next is not built (run pnpm build)");
    return;
  }

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-p5b-empty-"));
  try {
    const r = await runHarness("preact", {
      home: tmpHome,
      shotTag: "empty",
      forceOverflow,
    });
    if (r.skipped) { console.log(`[window-harness.test] ${r.skipped}`); t.skip(r.skipped); return; }

    assertShellFrame(r.res960, r.res1920);
    // (b) empty home -> 0 rows and emptyTitle === "No conversations yet"
    assert.strictEqual(r.res960.sessionRows, 0, "Expected 0 session rows for empty home at 960x740");
    assert.strictEqual(r.res960.emptyTitle, "No conversations yet");
    assert.strictEqual(r.res1920.sessionRows, 0, "Expected 0 session rows for empty home at 1920x1080");
    assert.strictEqual(r.res1920.emptyTitle, "No conversations yet");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: Preact session delete removes row and disk directory", async (t) => {
  const built = fs.existsSync(path.join(pkgRoot, "dist", "renderer-next", "index.html"));
  if (!built) {
    t.skip("dist/renderer-next is not built (run pnpm build)");
    return;
  }

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-p5b-delete-"));
  try {
    seedSessions(tmpHome, [
      { id: "del-target", firstLine: "Target to be deleted", mtime: new Date("2026-06-01T12:00:00Z") },
      { id: "del-keep", firstLine: "Keeper session", mtime: new Date("2026-05-01T12:00:00Z") },
    ]);

    const deleteScript = [
      "(async () => {",
      "  window.confirm = () => true;",
      "  const btn = document.querySelector('#sessionList .btn-delete-session');",
      "  if (!btn) return { error: 'no-delete-btn' };",
      "  const targetId = btn.getAttribute('data-session-id');",
      "  btn.click();",
      "  await new Promise((r) => setTimeout(r, 600));",
      "  const remainingRows = document.querySelectorAll('#sessionList .session-channel-item').length;",
      "  return { targetId, remainingRows };",
      "})()",
    ].join("\n");

    const r = await runHarness("preact", {
      home: tmpHome,
      interactScript: deleteScript,
      forceOverflow,
    });
    if (r.skipped) { console.log(`[window-harness.test] ${r.skipped}`); t.skip(r.skipped); return; }

    assert.ok(r.interactResult);
    assert.strictEqual(r.interactResult.targetId, "del-target");
    assert.strictEqual(r.interactResult.remainingRows, 1, "Exactly 1 row should remain after deletion");

    const deletedPath = path.join(tmpHome, ".opensand", "sessions", "del-target");
    assert.strictEqual(fs.existsSync(deletedPath), false, "Deleted session directory must be removed from disk");
    const keepPath = path.join(tmpHome, ".opensand", "sessions", "del-keep");
    assert.strictEqual(fs.existsSync(keepPath), true, "Non-deleted session directory must remain on disk");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness detects forced horizontal overflow", async (t) => {
  const r = await runHarness("default", { forceOverflow: true });
  if (r.skipped) { t.skip(r.skipped); return; }
  assert.strictEqual(r.res960.noOverflow, false, "a 3000px element must register as overflow at 960x740");
  assert.ok(r.res960.scrollWidth > r.res960.innerWidth);
});
