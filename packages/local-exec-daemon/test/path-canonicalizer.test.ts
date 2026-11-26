import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalizePath, canonicalizeArgumentPaths, PathEscapeError } from '../src/path-canonicalizer.js';

describe('PathCanonicalizer - canonical sandbox', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-canon-'));
    root = path.join(base, 'workspace');
    outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, 'a.txt'), 'inside');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  });

  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('canonicalizes a normal path inside the root', () => {
    assert.equal(
      canonicalizePath(path.join(root, 'a.txt'), root),
      fs.realpathSync(path.join(root, 'a.txt')),
    );
  });

  it('allows a new file inside the root by resolving its existing parent', () => {
    fs.mkdirSync(path.join(root, 'new'));
    assert.equal(
      canonicalizePath(path.join(root, 'new', 'note.txt'), root),
      path.join(fs.realpathSync(path.join(root, 'new')), 'note.txt'),
    );
  });

  it('rejects ../ traversal into a sensitive directory', () => {
    assert.throws(() => canonicalizePath('../outside/secret.txt', root), PathEscapeError);
    assert.throws(
      () => canonicalizePath(path.join(root, 'sub', '..', '..', 'outside', 'secret.txt'), root),
      PathEscapeError,
    );
  });

  it('rejects an absolute path outside the root', () => {
    assert.throws(() => canonicalizePath(path.join(outside, 'secret.txt'), root), PathEscapeError);
  });

  it('rejects symlink escapes to an outside file', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    assert.throws(() => canonicalizePath('link.txt', root), PathEscapeError);
  });

  it('allows a symlink that stays inside the root', () => {
    fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'alias.txt'));
    assert.equal(canonicalizePath('alias.txt', root), fs.realpathSync(path.join(root, 'a.txt')));
  });

  it('rejects null-byte injection', () => {
    assert.throws(() => canonicalizePath('a.txt\0/etc/passwd', root), PathEscapeError);
  });

  it('canonicalizes path arguments and command-line paths, rejecting escapes', () => {
    const paths = canonicalizeArgumentPaths(
      { path: 'a.txt', command: `cat ${path.join(root, 'a.txt')}` },
      root,
    );
    assert.ok(paths.includes(fs.realpathSync(path.join(root, 'a.txt'))));
    assert.throws(
      () => canonicalizeArgumentPaths({ command: `cat ${path.join(outside, 'secret.txt')}` }, root),
      PathEscapeError,
    );
  });
});
