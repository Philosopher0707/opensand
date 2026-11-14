import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { withElectronLock } from "./electron-lock.js";
import { EventLogWriter } from "@opensand/shared";
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
    "        await shot(win, 'interact');",
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

test("Real-Window Harness: Preact mission list reads missions from the hermetic HOME via opensand:listMissions", async (t) => {
  const built = fs.existsSync(path.join(pkgRoot, "dist", "renderer-next", "index.html"));
  if (!built) {
    t.skip("dist/renderer-next is not built (run pnpm build)");
    return;
  }

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-p5d-missions-"));
  try {
    const missionsDir = path.join(tmpHome, ".opensand", "missions");
    const write = async (id: string, events: Array<[string, any, string]>) => {
      const w = new EventLogWriter(path.join(missionsDir, id), { sessionId: id });
      for (const [kind, data, ts] of events) await w.append({ kind: kind as any, data, ts });
    };
    await write("m-wait", [
      ["mission.started", { title: "Ask the owner" }, "2026-11-14T09:00:00.000Z"],
      ["mission.needs-you", {}, "2026-11-14T09:05:00.000Z"],
    ]);
    await write("m-done", [
      ["mission.started", { title: "Fix the build" }, "2026-11-14T08:00:00.000Z"],
      ["mission.verified", {}, "2026-11-14T08:30:00.000Z"],
    ]);

    const listScript = [
      "(async () => {",
      "  const read = () => Array.from(document.querySelectorAll('.mission-item')).map((e) => ({",
      "    id: e.getAttribute('data-mission-id'),",
      "    title: e.querySelector('.mission-title')?.textContent?.trim() || '',",
      "    status: e.querySelector('.mission-status')?.textContent?.trim() || '',",
      "  }));",
      "  for (let i = 0; i < 40 && read().length < 2; i++) await new Promise((r) => setTimeout(r, 100));",
      "  return { rows: read() };",
      "})()",
    ].join("\n");

    const r = await runHarness("preact", { home: tmpHome, shotTag: "missions", interactScript: listScript, forceOverflow });
    if (r.skipped) { console.log(`[window-harness.test] ${r.skipped}`); t.skip(r.skipped); return; }

    assert.deepStrictEqual(r.interactResult.rows, [
      { id: "m-wait", title: "Ask the owner", status: "Waiting for you" },
      { id: "m-done", title: "Fix the build", status: "Done" },
    ]);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Real-Window Harness: Preact selecting a mission shows its timeline from opensand:getMissionTimeline", async (t) => {
  const built = fs.existsSync(path.join(pkgRoot, "dist", "renderer-next", "index.html"));
  if (!built) {
    t.skip("dist/renderer-next is not built (run pnpm build)");
    return;
  }

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-p5e-timeline-"));
  try {
    const w = new EventLogWriter(path.join(tmpHome, ".opensand", "missions", "m-demo"), { sessionId: "m-demo" });
    const rows: Array<[string, any, string]> = [
      ["mission.started", { title: "Fix the failing build" }, "2026-11-14T09:00:00.000Z"],
      ["node.completed", { node: "plan", durationMs: 1800 }, "2026-11-14T09:00:02.000Z"],
      ["node.completed", { node: "act", claim: "Edited packages/engine/src/missions/receipt.ts", durationMs: 41200 }, "2026-11-14T09:00:44.000Z"],
      ["check.completed", { passed: false, exitCode: 1 }, "2026-11-14T09:00:50.000Z"],
      ["node.completed", { node: "repair", durationMs: 9000 }, "2026-11-14T09:01:00.000Z"],
      ["check.completed", { passed: true, exitCode: 0 }, "2026-11-14T09:01:20.000Z"],
      ["review.completed", { accept: true, note: "Matches the goal" }, "2026-11-14T09:01:30.000Z"],
      ["node.completed", { node: "receipt", durationMs: 40 }, "2026-11-14T09:01:31.000Z"],
      ["mission.verified", { receipt: "ignored" }, "2026-11-14T09:01:32.000Z"],
    ];
    for (const [kind, data, ts] of rows) await w.append({ kind: kind as any, data, ts });

    const script = [
      "(async () => {",
      "  const wait = async (fn) => { for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 100)); };",
      "  await wait(() => document.querySelector('.mission-item'));",
      "  document.querySelector('.mission-item').click();",
      "  await wait(() => document.querySelector('.timeline-step'));",
      "  const steps = Array.from(document.querySelectorAll('.timeline-step')).map((e) => ({",
      "    kind: e.getAttribute('data-step-kind'),",
      "    summary: e.querySelector('.timeline-summary')?.textContent || '',",
      "    hasTime: /^\\d\\d:\\d\\d:\\d\\d$/.test(e.querySelector('.timeline-time')?.textContent || ''),",
      "  }));",
      "  const list = document.querySelector('.timeline-steps');",
      "  list.focus();",
      "  return { steps, listFocusable: document.activeElement === list, noOverflow: document.documentElement.scrollWidth <= window.innerWidth };",
      "})()",
    ].join("\n");

    const r = await runHarness("preact", { home: tmpHome, shotTag: "timeline", interactScript: script, forceOverflow });
    if (r.skipped) { console.log(`[window-harness.test] ${r.skipped}`); t.skip(r.skipped); return; }

    assert.deepStrictEqual(r.interactResult.steps.map((s: any) => s.kind), ["start", "plan", "act", "check", "repair", "check", "review", "receipt", "end"]);
    assert.strictEqual(r.interactResult.steps[0].summary, "Fix the failing build");
    assert.strictEqual(r.interactResult.steps[8].summary, "Verified");
    assert.ok(r.interactResult.steps.every((s: any) => s.hasTime), "every step shows a time");
    assert.strictEqual(r.interactResult.listFocusable, true, "timeline list is keyboard focusable");
    assert.strictEqual(r.interactResult.noOverflow, true);
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
