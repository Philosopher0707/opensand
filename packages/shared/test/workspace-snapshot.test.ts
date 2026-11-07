import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkspaceSnapshot, revertWorkspaceSnapshot } from '../src/workspace-snapshot.js';

test('createWorkspaceSnapshot and revertWorkspaceSnapshot - restores modified, deleted, and removes added files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-snapshot-test-'));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-snapshot-storage-'));

  try {
    // 1. Initial workspace state
    const file1 = path.join(tmpDir, 'file1.txt');
    const file2 = path.join(tmpDir, 'sub', 'file2.txt');
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
    fs.writeFileSync(file1, 'initial content 1', 'utf8');
    fs.writeFileSync(file2, 'initial content 2', 'utf8');

    // 2. Snapshot
    const turnId = 'turn-001';
    const manifest = createWorkspaceSnapshot(tmpDir, turnId, storageDir);
    assert.strictEqual(manifest.files.length, 2);

    // 3. Mutate workspace:
    // a) modify file1
    fs.writeFileSync(file1, 'tampered content 1', 'utf8');
    // b) delete file2
    fs.unlinkSync(file2);
    // c) create unexpected file3
    const file3 = path.join(tmpDir, 'unexpected.txt');
    fs.writeFileSync(file3, 'should be deleted', 'utf8');

    // 4. Revert
    const result = revertWorkspaceSnapshot(tmpDir, turnId, storageDir);
    assert.deepStrictEqual(result.restored.sort(), ['file1.txt', 'sub/file2.txt'].sort());
    assert.deepStrictEqual(result.deleted, ['unexpected.txt']);

    // 5. Assert byte-identical restoration
    assert.strictEqual(fs.readFileSync(file1, 'utf8'), 'initial content 1');
    assert.strictEqual(fs.readFileSync(file2, 'utf8'), 'initial content 2');
    assert.strictEqual(fs.existsSync(file3), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});
