import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { withElectronLock } from './electron-lock.js';
import { hermeticElectronEnv, makeTempHome } from './hermetic-env.js';

type Renderer = 'default' | 'preact';

interface HarnessResult {
  skipped?: string;
  res960?: any;
  res1920?: any;
}

const pkgRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function skipReason(): string | undefined {
  // Headless Linux CI environments without a display server cannot open GUI BrowserWindows.
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return 'Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY';
  }
  if (!fs.existsSync(path.join(pkgRoot, 'node_modules', '.bin', 'electron'))) {
    return 'Electron binary not found';
  }
  return undefined;
}

/**
 * Launches the real Electron main process (never a mocked BrowserWindow), sets
 * real content sizes and reads layout metrics from the live page.
 * Reuses Rigel's preload launcher pattern (fix/p0-preload-bridge).
 */
async function runHarness(renderer: Renderer, opts: { forceOverflow?: boolean } = {}): Promise<HarnessResult> {
  const reason = skipReason();
  if (reason) return { skipped: reason };

  const electronBin = path.join(pkgRoot, 'node_modules', '.bin', 'electron');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-window-harness-'));
  const tmpHome = makeTempHome('opensand-window-home-');
  const runnerScript = path.join(tmpDir, 'runner.mjs');
  const mainScript = path.join(pkgRoot, 'dist', 'src', 'main.js');

  const runnerCode = `
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const timeout = setTimeout(() => {
  console.error('[runner] Timeout waiting for real-window harness assertions');
  app.quit();
  process.exit(1);
}, 20000);

async function shot(win, label) {
  const dir = process.env.OPENSAND_HARNESS_SHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir, (process.env.OPENSAND_RENDERER || 'default') + '-' + label + '.png'), img.toPNG());
}

const METRICS = \`(() => {
  const q = (s) => document.querySelector(s);
  return {
    isElectron: document.body.classList.contains('is-electron'),
    trafficLightClearance: q('.sidebar') ? getComputedStyle(q('.sidebar')).paddingTop : null,
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    hasSidebar: !!q('.sidebar'),
    hasBrandHomeBtn: !!q('.sidebar #brandHomeBtn'),
    hasSessionList: !!q('.sidebar #sessionList'),
    hasSidebarFooter: !!q('.sidebar .sidebar-footer'),
    hasMainPanel: !!q('main.main-panel'),
    hasTopbar: !!q('main.main-panel header.topbar'),
    hasActiveSessionTitle: !!q('main.main-panel #activeSessionTitle'),
    hasViewChat: !!q('#viewChat'),
    hasChatContainer: !!q('#viewChat #chatContainer'),
    hasMessageFeed: !!q('#viewChat #messageFeed'),
    hasInputPanel: !!q('.input-panel'),
    hasPromptInput: !!q('.input-panel #promptInput'),
    hasBtnSend: !!q('.input-panel #btnSend'),
    sidebarWidth: q('.sidebar')?.getBoundingClientRect().width,
    mainWidth: q('main.main-panel')?.getBoundingClientRect().width,
    brandTop: q('#brandHomeBtn')?.getBoundingClientRect().top,
    titleBox: (() => { const r = q('#activeSessionTitle')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; })(),
    titleColor: q('#activeSessionTitle') ? getComputedStyle(q('#activeSessionTitle')).color : null
  };
})()\`;

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', async () => {
    try {
      // Dimension test 1: the default / minimum window size (960x740)
      win.setContentSize(960, 740);
      await new Promise((r) => setTimeout(r, 400));
      if (process.env.OPENSAND_HARNESS_FORCE_OVERFLOW === '1') {
        await win.webContents.executeJavaScript("document.body.insertAdjacentHTML('beforeend', '<div style=\\"width:3000px;height:4px\\"></div>')");
        await new Promise((r) => setTimeout(r, 100));
      }
      await shot(win, '960x740');
      const eval960 = await win.webContents.executeJavaScript(METRICS);

      // Dimension test 2: full-screen dimensions (1920x1080)
      win.setContentSize(1920, 1080);
      await new Promise((r) => setTimeout(r, 400));
      await shot(win, '1920x1080');
      const eval1920 = await win.webContents.executeJavaScript(METRICS);

      console.log('__EVAL_960__:' + JSON.stringify(eval960));
      console.log('__EVAL_1920__:' + JSON.stringify(eval1920));
      console.log('WINDOW_HARNESS_PASSED');
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error('[runner] Real-window assertion error:', err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});

// Auto-start the dev build of DesktopApp
await import(${JSON.stringify(mainScript)});
`;

  fs.writeFileSync(runnerScript, runnerCode, 'utf8');

  try {
    // Unset ELECTRON_RUN_AS_NODE so Electron runs as a real Electron GUI process.
    const env = hermeticElectronEnv(tmpHome);
    delete env.OPENSAND_RENDERER;
    if (renderer === 'preact') env.OPENSAND_RENDERER = 'preact';
    delete env.OPENSAND_HARNESS_FORCE_OVERFLOW;
    if (opts.forceOverflow) {
      env.OPENSAND_HARNESS_FORCE_OVERFLOW = '1';
      delete env.OPENSAND_HARNESS_SHOT_DIR; // keep the forced-overflow run out of the screenshot set
    }

    let stdout = '';
    let stderr = '';
    const exitCode = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runnerScript], {
        cwd: pkgRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      return new Promise<number>((resolve) => {
        child.on('close', (code) => resolve(code ?? 0));
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
    assert.ok(match960, 'Output must include __EVAL_960__');
    assert.ok(match1920, 'Output must include __EVAL_1920__');
    if (process.env.OPENSAND_HARNESS_VERBOSE === '1') console.log(`[window-harness.test] ${renderer} 960:`, match960[1]);
    return { res960: JSON.parse(match960[1]), res1920: JSON.parse(match1920[1]) };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

const forceOverflow = process.env.OPENSAND_HARNESS_FORCE_OVERFLOW === '1';

function assertShellFrame(res960: any, res1920: any): void {
  // 960x740
  assert.strictEqual(res960.isElectron, true, 'document.body must have .is-electron class');
  assert.strictEqual(res960.trafficLightClearance, '38px', 'Traffic light clearance must be 38px on macOS');
  assert.strictEqual(res960.noOverflow, true, `No horizontal overflow at 960x740: scrollWidth=${res960.scrollWidth}, innerWidth=${res960.innerWidth}`);
  assert.strictEqual(res960.hasSidebar, true, 'Aside .sidebar must be present');
  assert.strictEqual(res960.hasBrandHomeBtn, true, '.sidebar #brandHomeBtn must be present');
  assert.strictEqual(res960.hasSessionList, true, '.sidebar #sessionList must be present');
  assert.strictEqual(res960.hasSidebarFooter, true, '.sidebar .sidebar-footer must be present');
  assert.strictEqual(res960.hasMainPanel, true, 'main.main-panel must be present');
  assert.strictEqual(res960.hasTopbar, true, 'main.main-panel header.topbar must be present');
  assert.strictEqual(res960.hasActiveSessionTitle, true, 'main.main-panel #activeSessionTitle must be present');
  // 1920x1080
  assert.strictEqual(res1920.noOverflow, true, `No horizontal overflow at 1920x1080: scrollWidth=${res1920.scrollWidth}, innerWidth=${res1920.innerWidth}`);
  assert.strictEqual(res1920.hasSidebar, true, '.sidebar must remain mounted at 1920x1080');
  assert.strictEqual(res1920.hasMainPanel, true, 'main.main-panel must remain mounted at 1920x1080');
  assert.ok(res1920.mainWidth > 1200, `Main content must expand flexibly at full screen (measured ${res1920.mainWidth}px)`);
}

test('Real-Window Harness: default renderer (960x740 and full screen)', async (t) => {
  const r = await runHarness('default', { forceOverflow });
  if (r.skipped) { console.log(`[window-harness.test] ${r.skipped}`); t.skip(r.skipped); return; }
  assertShellFrame(r.res960, r.res1920);
  // Chat view and composer exist only in the default renderer until views are ported.
  assert.strictEqual(r.res960.hasViewChat, true, '#viewChat must be present');
  assert.strictEqual(r.res960.hasChatContainer, true, '#viewChat #chatContainer must be present');
  assert.strictEqual(r.res960.hasMessageFeed, true, '#viewChat #messageFeed must be present');
  assert.strictEqual(r.res960.hasInputPanel, true, '.input-panel must be present');
  assert.strictEqual(r.res960.hasPromptInput, true, '.input-panel #promptInput must be present');
  assert.strictEqual(r.res960.hasBtnSend, true, '.input-panel #btnSend must be present');
});

test('Real-Window Harness: Preact shell frame, OPENSAND_RENDERER=preact (960x740 and full screen)', async (t) => {
  const built = fs.existsSync(path.join(pkgRoot, 'dist', 'renderer-next', 'index.html'));
  if (!built) {
    const reason = 'dist/renderer-next is not built (run pnpm build)';
    t.skip(reason);
    return;
  }
  const r = await runHarness('preact', { forceOverflow });
  if (r.skipped) { console.log(`[window-harness.test] ${r.skipped}`); t.skip(r.skipped); return; }
  assertShellFrame(r.res960, r.res1920);
  // Prove the new renderer is the one under test, not a silent fallback.
  assert.strictEqual(r.res960.hasViewChat, false, 'Preact shell must not be the legacy DOM');
});

test('Real-Window Harness detects forced horizontal overflow', async (t) => {
  const r = await runHarness('default', { forceOverflow: true });
  if (r.skipped) { t.skip(r.skipped); return; }
  assert.strictEqual(r.res960.noOverflow, false, 'a 3000px element must register as overflow at 960x740');
  assert.ok(r.res960.scrollWidth > r.res960.innerWidth);
});
