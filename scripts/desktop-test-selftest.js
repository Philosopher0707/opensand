#!/usr/bin/env node
// Hermetic selftest for desktop-test.js: fake test files only, no Electron and no repo build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = process.env.OPENSAND_DESKTOP_TEST_SCRIPT
  ? resolve(process.env.OPENSAND_DESKTOP_TEST_SCRIPT)
  : fileURLToPath(new URL('./desktop-test.js', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'opensand-desktop-test-selftest-'));
const TEST_DIR = join(tmp, 'test');
mkdirSync(TEST_DIR, { recursive: true });

const fake = (name, body) =>
  writeFileSync(join(TEST_DIR, name), `import { test } from 'node:test';\n${body}\n`);
fake('unit.test.js', "test('unit', () => {});");
fake('nav-real-window.test.js', "test('nav', () => {});");

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
};

function run(limitMs) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dirname(SCRIPT),
    env: {
      ...process.env,
      OPENSAND_DESKTOP_TEST_DIR: TEST_DIR,
      OPENSAND_REAL_WINDOW_LIMIT_MS: String(limitMs),
    },
    encoding: 'utf8',
  });
}

let orphanPid;
try {
  let result = run(10_000);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 non-real-window files \(parallel\)/);
  assert.match(result.stdout, /real-window nav-real-window\.test\.js \(concurrency=1, limit 10s\)/);
  assert.match(result.stdout, /real-window nav-real-window\.test\.js [\d.]+s/);

  // Mutation: a real-window file over the ceiling must fail and name that file.
  fake('slow-real-window.test.js', "test('slow', () => new Promise((r) => setTimeout(r, 2000)));");
  result = run(700);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /FAIL slow-real-window\.test\.js exceeded 0\.7s/);

  // A timed-out file that leaves a grandchild behind must have that grandchild killed too.
  const orphanFile = join(tmp, 'orphan.pid');
  const grandchild = `require('fs').writeFileSync(${JSON.stringify(orphanFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  writeFileSync(join(TEST_DIR, 'orphan-real-window.test.js'), [
    "import { test } from 'node:test';",
    "import { spawn } from 'node:child_process';",
    `test('orphan', () => { spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); return new Promise(() => {}); });`,
    '',
  ].join('\n'));
  result = run(1500);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /FAIL orphan-real-window\.test\.js exceeded 1\.5s/);
  for (let i = 0; i < 40 && !existsSync(orphanFile); i++) sleepSync(50);
  orphanPid = Number(readFileSync(orphanFile, 'utf8'));
  assert.ok(Number.isInteger(orphanPid) && orphanPid > 0, 'grandchild wrote its PID');
  for (let i = 0; i < 20 && pidAlive(orphanPid); i++) sleepSync(50);
  assert.equal(pidAlive(orphanPid), false, `grandchild ${orphanPid} survived the group kill`);
  console.log('desktop-test-selftest: OK');
} finally {
  if (orphanPid && pidAlive(orphanPid)) {
    try { process.kill(orphanPid, 'SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(tmp, { recursive: true, force: true });
}
