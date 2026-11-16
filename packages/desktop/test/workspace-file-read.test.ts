import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readWorkspaceFile, MAX_WORKSPACE_READ_BYTES } from '../src/workspace-file-read.js';

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-read-')));
  const root = path.join(base, 'ws');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
  return { base, root, outside, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('read: a relative path and an absolute path inside the root return the file text', () => {
  const f = fixture();
  try {
    const rel = readWorkspaceFile(f.root, 'src/a.ts');
    assert.deepStrictEqual(rel, { ok: true, path: 'src/a.ts', content: 'export const a = 1;\n', bytes: 20 });
    const abs = readWorkspaceFile(f.root, path.join(f.root, 'src', 'a.ts'));
    assert.strictEqual(abs.ok, true);
  } finally { f.done(); }
});

test('path-escape: .., a foreign absolute path and a symlink out of the tree are all refused', () => {
  const f = fixture();
  try {
    assert.deepStrictEqual(readWorkspaceFile(f.root, '../outside/secret.txt'), { ok: false, reason: 'outside' });
    assert.deepStrictEqual(readWorkspaceFile(f.root, 'src/../../outside/secret.txt'), { ok: false, reason: 'outside' });
    assert.deepStrictEqual(readWorkspaceFile(f.root, path.join(f.outside, 'secret.txt')), { ok: false, reason: 'outside' });
    // A path outside that does not exist must also say 'outside', never 'not_found': the answer must not reveal what exists elsewhere.
    assert.deepStrictEqual(readWorkspaceFile(f.root, path.join(f.outside, 'no-such-file')), { ok: false, reason: 'outside' });
    assert.deepStrictEqual(readWorkspaceFile(f.root, '../no-such-file'), { ok: false, reason: 'outside' });
    assert.deepStrictEqual(readWorkspaceFile(f.root, '/etc/hosts'), { ok: false, reason: 'outside' });

    fs.symlinkSync(path.join(f.outside, 'secret.txt'), path.join(f.root, 'link.txt'));
    assert.deepStrictEqual(readWorkspaceFile(f.root, 'link.txt'), { ok: false, reason: 'outside' }, 'file symlink out');
    fs.symlinkSync(f.outside, path.join(f.root, 'linkdir'));
    assert.deepStrictEqual(readWorkspaceFile(f.root, 'linkdir/secret.txt'), { ok: false, reason: 'outside' }, 'directory symlink out');
    // A sibling whose name merely starts with the root name is not inside it.
    fs.mkdirSync(f.root + '-evil');
    fs.writeFileSync(path.join(f.root + '-evil', 'x.txt'), 'x');
    assert.deepStrictEqual(readWorkspaceFile(f.root, f.root + '-evil/x.txt'), { ok: false, reason: 'outside' });
  } finally { f.done(); }
});

test('read: a symlink that stays inside the root is followed', () => {
  const f = fixture();
  try {
    fs.symlinkSync(path.join(f.root, 'src', 'a.ts'), path.join(f.root, 'alias.ts'));
    const r = readWorkspaceFile(f.root, 'alias.ts');
    assert.strictEqual(r.ok, true);
    if (r.ok) assert.strictEqual(r.path, 'src/a.ts');
  } finally { f.done(); }
});

test('read: bad input, missing file, directory, oversize and binary are reported, never returned', () => {
  const f = fixture();
  try {
    for (const bad of [undefined, null, 42, '', 'a\0b']) {
      assert.deepStrictEqual(readWorkspaceFile(f.root, bad), { ok: false, reason: 'invalid' });
    }
    assert.deepStrictEqual(readWorkspaceFile(f.root, 'nope.ts'), { ok: false, reason: 'not_found' });
    assert.deepStrictEqual(readWorkspaceFile(f.root, 'src'), { ok: false, reason: 'not_file' });
    fs.writeFileSync(path.join(f.root, 'big.txt'), 'x'.repeat(MAX_WORKSPACE_READ_BYTES + 1));
    assert.deepStrictEqual(readWorkspaceFile(f.root, 'big.txt'), { ok: false, reason: 'too_large' });
    assert.strictEqual(readWorkspaceFile(f.root, 'big.txt', MAX_WORKSPACE_READ_BYTES + 1).ok, true, 'the cap is the limit');
    fs.writeFileSync(path.join(f.root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    assert.deepStrictEqual(readWorkspaceFile(f.root, 'bin.dat'), { ok: false, reason: 'binary' });
    assert.deepStrictEqual(readWorkspaceFile(path.join(f.base, 'missing-root'), 'a.ts'), { ok: false, reason: 'not_found' });
  } finally { f.done(); }
});
