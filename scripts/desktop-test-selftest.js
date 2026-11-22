#!/usr/bin/env node
// Hermetic selftest for desktop-test.js: fake test files only, no Electron and no repo build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./desktop-test.js', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'opensand-desktop-test-selftest-'));
const TEST_DIR = join(tmp, 'test');
mkdirSync(TEST_DIR, { recursive: true });

const fake = (name, body) =>
  writeFileSync(join(TEST_DIR, name), `import { test } from 'node:test';\n${body}\n`);
fake('unit.test.js', "test('unit', () => {});");
fake('nav-real-window.test.js', "test('nav', () => {});");

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
  console.log('desktop-test-selftest: OK');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
