import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { withElectronLock } from './electron-lock.js';

test('Automated Real-Window Test Harness (Layout Stability at 960x740 and Full Screen)', async (t) => {
  // Headless Linux CI environments without a display server cannot open GUI BrowserWindows.
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    const reason = 'Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY';
    console.log(`[window-harness.test] ${reason}`);
    t.skip(reason);
    return;
  }

  const pkgRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const electronBin = path.join(pkgRoot, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) {
    const reason = 'Electron binary not found at ' + electronBin;
    console.log(`[window-harness.test] ${reason}`);
    t.skip(reason);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-window-harness-'));
  const runnerScript = path.join(tmpDir, 'runner.mjs');
  const mainScript = path.join(pkgRoot, 'dist', 'src', 'main.js');

  // Electron runner script executed within the real Electron main process
  // Reuses Rigel's preload launcher pattern (fix/p0-preload-bridge)
  const runnerCode = `
import { app } from 'electron';

const timeout = setTimeout(() => {
  console.error('[runner] Timeout waiting for real-window harness assertions');
  app.quit();
  process.exit(1);
}, 20000);

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', async () => {
    try {
      // Dimension test 1: Resize to exact default / minimum size (960x740)
      win.setContentSize(960, 740);
      await new Promise((r) => setTimeout(r, 400));

      const eval960 = await win.webContents.executeJavaScript(\`({
        isElectron: document.body.classList.contains('is-electron'),
        trafficLightClearance: window.getComputedStyle(document.querySelector('.sidebar')).paddingTop,
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
        // Aside: .sidebar contains #brandHomeBtn, #sessionList, .sidebar-footer
        hasSidebar: !!document.querySelector('.sidebar'),
        hasBrandHomeBtn: !!document.querySelector('.sidebar #brandHomeBtn'),
        hasSessionList: !!document.querySelector('.sidebar #sessionList'),
        hasSidebarFooter: !!document.querySelector('.sidebar .sidebar-footer'),
        // Main panel: main.main-panel contains header.topbar, #activeSessionTitle
        hasMainPanel: !!document.querySelector('main.main-panel'),
        hasTopbar: !!document.querySelector('main.main-panel header.topbar'),
        hasActiveSessionTitle: !!document.querySelector('main.main-panel #activeSessionTitle'),
        // Chat view: #viewChat contains #chatContainer, #messageFeed
        hasViewChat: !!document.querySelector('#viewChat'),
        hasChatContainer: !!document.querySelector('#viewChat #chatContainer'),
        hasMessageFeed: !!document.querySelector('#viewChat #messageFeed'),
        // Composer: .input-panel contains #promptInput, #btnSend
        hasInputPanel: !!document.querySelector('.input-panel'),
        hasPromptInput: !!document.querySelector('.input-panel #promptInput'),
        hasBtnSend: !!document.querySelector('.input-panel #btnSend'),
        sidebarWidth: document.querySelector('.sidebar')?.getBoundingClientRect().width,
        mainWidth: document.querySelector('main.main-panel')?.getBoundingClientRect().width
      })\`);

      // Dimension test 2: Resize to full-screen dimensions (1920x1080)
      win.setContentSize(1920, 1080);
      await new Promise((r) => setTimeout(r, 400));

      const eval1920 = await win.webContents.executeJavaScript(\`({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
        hasSidebar: !!document.querySelector('.sidebar'),
        hasMainPanel: !!document.querySelector('main.main-panel'),
        sidebarWidth: document.querySelector('.sidebar')?.getBoundingClientRect().width,
        mainWidth: document.querySelector('main.main-panel')?.getBoundingClientRect().width
      })\`);

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
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    let stdout = '';
    let stderr = '';
    const exitCode = await withElectronLock(async () => {
      const child = spawn(electronBin, [
        `--user-data-dir=${tmpDir}`,
        runnerScript,
      ], {
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
    assert.match(
      stdout,
      /WINDOW_HARNESS_PASSED/,
      `Expected WINDOW_HARNESS_PASSED in stdout, got:\n${stdout}\nstderr:\n${stderr}`
    );

    const match960 = stdout.match(/__EVAL_960__:(.*)/);
    const match1920 = stdout.match(/__EVAL_1920__:(.*)/);

    assert.ok(match960, 'Output must include __EVAL_960__');
    assert.ok(match1920, 'Output must include __EVAL_1920__');

    const res960 = JSON.parse(match960[1]);
    const res1920 = JSON.parse(match1920[1]);

    // Dimension test 1 assertions (960x740)
    assert.strictEqual(res960.isElectron, true, 'document.body must have .is-electron class');
    assert.strictEqual(res960.trafficLightClearance, '38px', 'Traffic light clearance must be 38px on macOS');
    assert.strictEqual(res960.noOverflow, true, `No horizontal overflow at 960x740: scrollWidth=${res960.scrollWidth}, innerWidth=${res960.innerWidth}`);

    // Verified real index.html DOM landmarks
    assert.strictEqual(res960.hasSidebar, true, 'Aside .sidebar must be present');
    assert.strictEqual(res960.hasBrandHomeBtn, true, '.sidebar #brandHomeBtn must be present');
    assert.strictEqual(res960.hasSessionList, true, '.sidebar #sessionList must be present');
    assert.strictEqual(res960.hasSidebarFooter, true, '.sidebar .sidebar-footer must be present');

    assert.strictEqual(res960.hasMainPanel, true, 'main.main-panel must be present');
    assert.strictEqual(res960.hasTopbar, true, 'main.main-panel header.topbar must be present');
    assert.strictEqual(res960.hasActiveSessionTitle, true, 'main.main-panel #activeSessionTitle must be present');

    assert.strictEqual(res960.hasViewChat, true, '#viewChat must be present');
    assert.strictEqual(res960.hasChatContainer, true, '#viewChat #chatContainer must be present');
    assert.strictEqual(res960.hasMessageFeed, true, '#viewChat #messageFeed must be present');

    assert.strictEqual(res960.hasInputPanel, true, '.input-panel must be present');
    assert.strictEqual(res960.hasPromptInput, true, '.input-panel #promptInput must be present');
    assert.strictEqual(res960.hasBtnSend, true, '.input-panel #btnSend must be present');

    // Dimension test 2 assertions (1920x1080)
    assert.strictEqual(res1920.noOverflow, true, `No horizontal overflow at 1920x1080: scrollWidth=${res1920.scrollWidth}, innerWidth=${res1920.innerWidth}`);
    assert.strictEqual(res1920.hasSidebar, true, '.sidebar must remain mounted at 1920x1080');
    assert.strictEqual(res1920.hasMainPanel, true, 'main.main-panel must remain mounted at 1920x1080');
    assert.ok(res1920.mainWidth > 1200, `Main content must expand flexibly at full screen (measured ${res1920.mainWidth}px)`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
