import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { withElectronLock } from './electron-lock.js';

test('real-Electron dev window loads preload bridge and exposes window.opensand', async (t) => {
  // Headless Linux CI environments without a display server cannot open GUI BrowserWindows.
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    const reason = 'Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY';
    console.log(`[preload-bridge.test] ${reason}`);
    t.skip(reason);
    return;
  }

  const pkgRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const electronBin = path.join(pkgRoot, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) {
    const reason = 'Electron binary not found at ' + electronBin;
    console.log(`[preload-bridge.test] ${reason}`);
    t.skip(reason);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-preload-test-'));
  const runnerScript = path.join(tmpDir, 'runner.mjs');
  const mainScript = path.join(pkgRoot, 'dist', 'src', 'main.js');

  // Electron runner script executed within the real Electron main process
  const runnerCode = `
import { app } from 'electron';

const timeout = setTimeout(() => {
  console.error('[runner] Timeout waiting for main window bridge assertions');
  app.quit();
  process.exit(1);
}, 15000);

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', async () => {
    try {
      const type = await win.webContents.executeJavaScript('typeof window.opensand');
      if (type !== 'object') {
        throw new Error('Expected typeof window.opensand to be "object", received: ' + type);
      }

      const sessions = await win.webContents.executeJavaScript('window.opensand.getSessions()');
      if (!Array.isArray(sessions)) {
        throw new Error('Expected getSessions() to return an array, received: ' + JSON.stringify(sessions));
      }

      console.log('ASSERTIONS_PASSED: typeof window.opensand = object, getSessions returned ' + sessions.length + ' sessions');
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error('[runner] Assertion failed:', err);
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
      `Electron runner failed with exit code ${exitCode}.\nstdout: ${stdout}\nstderr: ${stderr}`
    );
    assert.match(
      stdout,
      /ASSERTIONS_PASSED/,
      `Expected ASSERTIONS_PASSED in stdout, got:\n${stdout}\nstderr:\n${stderr}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
