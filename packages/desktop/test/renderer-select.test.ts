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

test('default renderer is used unless OPENSAND_RENDERER=preact', () => {
  const src = fakeDist(true);
  assert.strictEqual(resolveRendererDir(src, {}), path.join(src, '../../renderer'));
  assert.strictEqual(resolveRendererDir(src, { OPENSAND_RENDERER: 'legacy' }), path.join(src, '../../renderer'));
});

test('OPENSAND_RENDERER=preact serves dist/renderer-next when built', () => {
  const src = fakeDist(true);
  assert.strictEqual(resolveRendererDir(src, { OPENSAND_RENDERER: 'preact' }), path.join(src, '../renderer-next'));
});

test('OPENSAND_RENDERER=preact falls back to the default when not built', () => {
  const src = fakeDist(false);
  assert.strictEqual(resolveRendererDir(src, { OPENSAND_RENDERER: 'preact' }), path.join(src, '../../renderer'));
});
