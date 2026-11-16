import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Follow-up to #84: an edit to a file never seen whole used to show "(partial)". It now reads the file.
const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel: string) => import(pathToFileURL(path.join(here, '../../renderer', rel)).href);

const AFTER = ['one', 'two', 'three', 'FOUR', 'five', 'six'].join('\n');
const okResult = { status: 'ok', output: { path: '/w/a.txt', replacementCount: 1 } };

test('unseen-1 an edit to an unseen file reads the workspace and shows the WHOLE file with the real hunk', async () => {
  const { createFileModel, artifactForToolResult, wholeFileForPartialEdit } = await load('modules/chat/file-model.js');
  const model = createFileModel();
  const args = { path: '/w/a.txt', old_string: 'four', new_string: 'FOUR' };
  const first = artifactForToolResult(model, 'edit_file', args, okResult);
  assert.strictEqual(first.partial, true, 'sync path still labels the snippet partial');

  const reads: string[] = [];
  const whole = await wholeFileForPartialEdit(model, args, okResult, async (p: string) => { reads.push(p); return { ok: true, content: AFTER }; });
  assert.deepStrictEqual(reads, ['/w/a.txt']);
  assert.strictEqual(whole.content, AFTER, 'Code tab holds the full file from disk');
  assert.strictEqual(whole.title, 'a.txt', 'no "(partial)" label');
  assert.strictEqual(whole.filePath, '/w/a.txt', 'same tab key, so it replaces the snippet in place');
  assert.strictEqual(whole.diffExact, true);
  assert.match(whole.diff, /^-four$/m);
  assert.match(whole.diff, /^\+FOUR$/m);
  assert.match(whole.diff, /^ three$/m, 'unchanged context lines are present');
  assert.strictEqual(model.has('/w/a.txt'), true, 'cached, so the next edit needs no read');
  const next = artifactForToolResult(model, 'edit_file', { path: '/w/a.txt', old_string: 'six', new_string: 'SIX' }, okResult);
  assert.strictEqual(next.partial, undefined);
  assert.strictEqual(next.content, AFTER.replace('six', 'SIX'));
});

test('unseen-2 replace_all reverses only when the occurrence count matches; else the whole file with an honest snippet diff', async () => {
  const { createFileModel, wholeFileForPartialEdit } = await load('modules/chat/file-model.js');
  const text = 'x\nNEW\ny\nNEW\n';
  const exact = await wholeFileForPartialEdit(createFileModel(), { path: '/w/b', old_string: 'old', new_string: 'NEW', replace_all: true },
    { status: 'ok', output: { replacementCount: 2 } }, async () => ({ ok: true, content: text }));
  assert.strictEqual(exact.diffExact, true);
  assert.strictEqual((exact.diff.match(/^-old$/gm) || []).length, 2);

  const ambiguous = await wholeFileForPartialEdit(createFileModel(), { path: '/w/b', old_string: 'old', new_string: 'NEW' },
    { status: 'ok', output: { replacementCount: 1 } }, async () => ({ ok: true, content: text }));
  assert.strictEqual(ambiguous.content, text, 'still the whole file');
  assert.strictEqual(ambiguous.diffExact, false, 'NEW appears twice but one was replaced: do not guess');
});

test('unseen-3 a refused, failed or missing read leaves the partial snippet (null), never a blank tab', async () => {
  const { createFileModel, wholeFileForPartialEdit } = await load('modules/chat/file-model.js');
  const args = { path: '/w/a.txt', old_string: 'a', new_string: 'b' };
  for (const reader of [
    async () => ({ ok: false, reason: 'outside' }),
    async () => ({ ok: false, reason: 'too_large' }),
    async () => { throw new Error('bridge down'); },
    async () => undefined,
  ]) {
    assert.strictEqual(await wholeFileForPartialEdit(createFileModel(), args, okResult, reader as any), null);
  }
  assert.strictEqual(await wholeFileForPartialEdit(createFileModel(), args, okResult, undefined as any), null);
});
