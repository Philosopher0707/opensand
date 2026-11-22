#!/usr/bin/env node
// Desktop tests in two phases: fast files keep node's parallel runner, real-window files run
// one process at a time so Electron windows never contend. Each real-window file gets a wall-clock
// duration in the log and a hard ceiling; a slow file fails by name.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_DIR = process.env.OPENSAND_DESKTOP_TEST_DIR
  ? resolve(process.env.OPENSAND_DESKTOP_TEST_DIR)
  : join(ROOT, 'packages/desktop/dist/test');
const LIMIT_MS = Number(process.env.OPENSAND_REAL_WINDOW_LIMIT_MS ?? 120_000);

const files = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js')).sort();
const realWindow = files.filter((f) => f.endsWith('-real-window.test.js'));
const other = files.filter((f) => !f.endsWith('-real-window.test.js'));

function run(label, args, options = {}) {
  console.log(`desktop-test: ${label}`);
  return spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', ...options });
}

function check(result) {
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// Phase 1: every non-real-window file, left at node's default concurrency.
if (other.length) {
  const status = check(run(`${other.length} non-real-window files (parallel)`, [
    '--test', ...other.map((f) => join(TEST_DIR, f)),
  ]));
  if (status !== 0) process.exit(status);
}

// Phase 2: one process per real-window file. This is concurrency 1 by construction; the flag
// is passed explicitly so the intent survives a future change to a single multi-file invocation.
for (const file of realWindow) {
  const started = Date.now();
  const result = run(`real-window ${file} (concurrency=1, limit ${LIMIT_MS / 1000}s)`, [
    '--test', '--test-concurrency=1', join(TEST_DIR, file),
  ], { timeout: LIMIT_MS });
  const elapsed = Date.now() - started;
  console.log(`desktop-test: real-window ${file} ${(elapsed / 1000).toFixed(1)}s`);

  if (result.error?.code === 'ETIMEDOUT' || elapsed >= LIMIT_MS) {
    console.error(`desktop-test: FAIL ${file} exceeded ${LIMIT_MS / 1000}s`);
    process.exit(1);
  }
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0) {
    console.error(`desktop-test: FAIL ${file} exited ${status}`);
    process.exit(status);
  }
}

console.log(`desktop-test: done (${other.length} parallel, ${realWindow.length} serial)`);
