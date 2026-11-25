import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRendererDir } from '../src/desktop-server.js';

function fakeDist(withNext: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-renderer-'));
  const src = path.join(root, 'dist', 'src');
  fs.mkdirSync(src, { recursive: true });
  if (withNext) {
    fs.mkdirSync(path.join(root, 'dist', 'renderer-next'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'renderer-next', 'index.html'), '<html></html>');
  }
  return src;
}

function warningsDuring(fn: () => void): string[] {
  const original = console.warn;
  const seen: string[] = [];
  console.warn = (...args: unknown[]) => { seen.push(args.join(' ')); };
  try { fn(); } finally { console.warn = original; }
  return seen;
}

test('renderer-next is the default when built', () => {
  const src = fakeDist(true);
  assert.strictEqual(resolveRendererDir(src, {}), path.join(src, '../renderer-next'));
  assert.strictEqual(resolveRendererDir(src, { OPENSAND_RENDERER: 'preact' }), path.join(src, '../renderer-next'));
});

test('OPENSAND_RENDERER=legacy keeps the old renderer even when next is built', () => {
  const src = fakeDist(true);
  assert.strictEqual(resolveRendererDir(src, { OPENSAND_RENDERER: 'legacy' }), path.join(src, '../../renderer'));
});

test('missing next build falls back to the legacy renderer with a warning', () => {
  const src = fakeDist(false);
  const legacy = path.join(src, '../../renderer');
  for (const env of [{}, { OPENSAND_RENDERER: 'preact' }]) {
    const seen = warningsDuring(() => {
      assert.strictEqual(resolveRendererDir(src, env), legacy);
    });
    assert.match(seen.join('\n'), /renderer-next is missing.*legacy renderer/);
  }
});
