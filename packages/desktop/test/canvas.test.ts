import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const canvasModulePath = path.join(__dirname, '../../renderer/modules/chat/canvas.js');

test('Artifact Canvas - resolveLanguageMeta maps known extensions and languages', async () => {
  const { resolveLanguageMeta } = await import(pathToFileURL(canvasModulePath).href);
  assert.strictEqual(resolveLanguageMeta('ts').label, 'TypeScript');
  assert.strictEqual(resolveLanguageMeta('typescript').label, 'TypeScript');
  assert.strictEqual(resolveLanguageMeta('html').previewable, true);
  assert.strictEqual(resolveLanguageMeta('svg').previewable, true);
  assert.strictEqual(resolveLanguageMeta('md').previewable, true);
  assert.strictEqual(resolveLanguageMeta('markdown').previewable, true);
  assert.strictEqual(resolveLanguageMeta('unknown_custom').label, 'UNKNOWN_CUSTOM');
  assert.strictEqual(resolveLanguageMeta(null).label, 'Code');
});

test('Artifact Canvas - generateLineNumbers returns sequential lines', async () => {
  const { generateLineNumbers } = await import(pathToFileURL(canvasModulePath).href);
  assert.strictEqual(generateLineNumbers('one'), '1');
  assert.strictEqual(generateLineNumbers('one\ntwo\nthree'), '1\n2\n3');
  assert.strictEqual(generateLineNumbers(''), '1');
});

test('Artifact Canvas - parseUnifiedDiff parses chunks, additions, deletions and headers', async () => {
  const { parseUnifiedDiff } = await import(pathToFileURL(canvasModulePath).href);
  const sampleDiff = `--- a/file.ts
+++ b/file.ts
@@ -10,3 +10,4 @@
 context line
-deleted line
+added line 1
+added line 2`;

  const records = parseUnifiedDiff(sampleDiff);
  assert.strictEqual(records.length, 7);
  assert.strictEqual(records[0].type, 'file-header');
  assert.strictEqual(records[1].type, 'file-header');
  assert.strictEqual(records[2].type, 'chunk');
  assert.strictEqual(records[3].type, 'context');
  assert.strictEqual(records[3].oldNum, 10);
  assert.strictEqual(records[3].newNum, 10);
  assert.strictEqual(records[4].type, 'del');
  assert.strictEqual(records[4].oldNum, 11);
  assert.strictEqual(records[4].text, 'deleted line');
  assert.strictEqual(records[5].type, 'add');
  assert.strictEqual(records[5].newNum, 11);
  assert.strictEqual(records[5].text, 'added line 1');
  assert.strictEqual(records[6].type, 'add');
  assert.strictEqual(records[6].newNum, 12);
  assert.strictEqual(records[6].text, 'added line 2');
});

test('Artifact Canvas - renderDiffHtml produces escaped rows', async () => {
  const { renderDiffHtml } = await import(pathToFileURL(canvasModulePath).href);
  const diff = `@@ -1,1 +1,1 @@
-const a = <script>;
+const a = <safe>;`;

  const html = renderDiffHtml(diff, (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  assert.ok(html.includes('diff-table'));
  assert.ok(html.includes('diff-row-del'));
  assert.ok(html.includes('diff-row-add'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;safe&gt;'));
});

test('Artifact Canvas - createArtifactCanvas lifecycle and tab transitions', async () => {
  const { createArtifactCanvas } = await import(pathToFileURL(canvasModulePath).href);
  const canvas = createArtifactCanvas();
  assert.strictEqual(canvas.getState().isOpen, false);
  assert.strictEqual(canvas.getState().activeTab, 'code');

  // Open code artifact
  canvas.openArtifact({
    title: 'test.ts',
    language: 'typescript',
    content: 'const x = 1;',
  });
  assert.strictEqual(canvas.getState().isOpen, true);
  assert.strictEqual(canvas.getState().title, 'test.ts');
  assert.strictEqual(canvas.getState().activeTab, 'code');

  // Open HTML artifact with autoPreview
  canvas.openArtifact({
    title: 'preview.html',
    language: 'html',
    content: '<h1>Hello</h1>',
    autoPreview: true,
  });
  assert.strictEqual(canvas.getState().activeTab, 'preview');

  // Switch tabs
  canvas.switchTab('diff');
  assert.strictEqual(canvas.getState().activeTab, 'diff');

  // Toggle fullscreen
  canvas.setFullscreen(true);
  assert.strictEqual(canvas.getState().isFullscreen, true);
  canvas.toggleFullscreen();
  assert.strictEqual(canvas.getState().isFullscreen, false);

  // Close artifact
  canvas.closeArtifact();
  assert.strictEqual(canvas.getState().isOpen, false);
});
