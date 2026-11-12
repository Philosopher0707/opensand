import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { withElectronLock } from './electron-lock.js';
import { hermeticElectronEnv, makeTempHome } from './hermetic-env.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function mtimeOrNull(file: string): number | null {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

test('real-Electron launch under hermeticElectronEnv writes state to the temp HOME, not the real one', async (t) => {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    t.skip('Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY');
    return;
  }
  const electronBin = path.join(pkgRoot, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) {
    t.skip('Electron binary not found at ' + electronBin);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-hermetic-test-'));
  const tmpHome = makeTempHome('opensand-hermetic-home-');
  const runnerScript = path.join(tmpDir, 'runner.mjs');
  const mainScript = path.join(pkgRoot, 'dist', 'src', 'main.js');
  const realSchema = path.join(os.homedir(), '.opensand', 'state', 'schema.json');
  const tmpSchema = path.join(tmpHome, '.opensand', 'state', 'schema.json');
  const realBefore = mtimeOrNull(realSchema);

  // Start the real app, wait until it has created its state, then quit.
  fs.writeFileSync(runnerScript, `
import { app } from 'electron';
import fs from 'node:fs';
const schema = ${JSON.stringify(tmpSchema)};
const timeout = setTimeout(() => { console.error('[runner] timeout'); app.quit(); process.exit(1); }, 20000);
const poll = setInterval(() => {
  if (fs.existsSync(schema)) { clearInterval(poll); clearTimeout(timeout); console.log('STATE_WRITTEN'); app.quit(); process.exit(0); }
}, 100);
await import(${JSON.stringify(mainScript)});
`, 'utf8');

  try {
    let stdout = '';
    let stderr = '';
    const exitCode = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runnerScript], {
        cwd: pkgRoot,
        env: hermeticElectronEnv(tmpHome),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      return new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 0)));
    });

    assert.ok(
      fs.existsSync(tmpSchema),
      `Expected ${tmpSchema} to exist (exit ${exitCode}).\nstdout: ${stdout}\nstderr: ${stderr}`
    );
    assert.strictEqual(
      mtimeOrNull(realSchema),
      realBefore,
      `The real ${realSchema} changed: the launch touched the owner's state`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
