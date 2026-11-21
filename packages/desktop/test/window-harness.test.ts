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
    "  const chips = Array.from(document.querySelectorAll('#botList .bot-model-chip')).map((e) => e.textContent.trim());",
    "  const btn = document.querySelector('#botList .btn-bot-model');",
    "  btn?.click();",
    "  await new Promise((r) => setTimeout(r, 500));",
    "  const pop = document.querySelector('.mp-popover');",
    "  const result = {",
    "    chips,",
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
    assert.ok((result.chips || []).some((c: string) => c.includes('openrouter')), `bot card must show provider chip (${JSON.stringify(result)})`);
    assert.ok(result.avatars >= 2, `every bot card needs an avatar (${JSON.stringify(result)})`);
    assert.ok((result.providerBadges || []).includes('O'), `bot card needs a provider badge (${JSON.stringify(result)})`);
    assert.ok(result.statusDots >= 2, `bot card needs a status dot (${JSON.stringify(result)})`);
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
    "  rows[1]?.click();",
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
    "    chip: Array.from(document.querySelectorAll('#botList .bot-model-chip')).map((e) => e.textContent.trim()),",
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
    assert.ok((result.chip || []).some((c: string) => c.includes('patched-model-xyz')), `card chip must update after save (${JSON.stringify(result)})`);
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
