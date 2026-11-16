import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Issue #82: four Artifact Canvas bugs in the shipped (old) renderer.
const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(here, '../../renderer');
const load = (rel: string) => import(pathToFileURL(path.join(rendererDir, rel)).href);

const FILE = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].join('\n');

// ---- 1. edit_file shows the whole file, with a real diff ---------------------------------

test('#82-1 edit_file after write_file opens the WHOLE file, not the replacement', async () => {
  const { createFileModel, artifactForToolResult } = await load('modules/chat/file-model.js');
  const model = createFileModel();
  artifactForToolResult(model, 'write_file', { path: '/r/a.txt', content: FILE }, { status: 'ok' });

  const art = artifactForToolResult(
    model, 'edit_file',
    { path: '/r/a.txt', old_string: 'five', new_string: 'FIVE' },
    { status: 'ok', output: { path: '/r/a.txt', replacementCount: 1 } },
  );
  assert.ok(art, 'a successful edit opens an artifact');
  assert.strictEqual(art.content, FILE.replace('five', 'FIVE'), 'Code tab holds the full current file');
  assert.strictEqual(art.filePath, '/r/a.txt', 'same path key as write_file, so it updates that tab');
  assert.strictEqual(art.title, 'a.txt');
  assert.match(art.diff, /^@@ -2,7 \+2,7 @@$/m, 'diff carries the real line numbers, not 1,1');
  assert.match(art.diff, /^-five$/m);
  assert.match(art.diff, /^\+FIVE$/m);
  assert.match(art.diff, /^ four$/m, 'context lines are present');
});

test('#82-1 edit_file seeds from an unbounded read_file, honours replace_all, ignores ranged reads', async () => {
  const { createFileModel, artifactForToolResult } = await load('modules/chat/file-model.js');
  const model = createFileModel();
  artifactForToolResult(model, 'read_file', { path: '/r/b.txt', start_line: 1, end_line: 2 },
    { status: 'ok', output: { path: '/r/b.txt', content: 'x\nx' } });
  assert.strictEqual(model.has('/r/b.txt'), false, 'a ranged read is not the file');

  artifactForToolResult(model, 'read_file', { path: '/r/b.txt' },
    { status: 'ok', output: { path: '/r/b.txt', content: 'x\ny\nx' } });
  const art = artifactForToolResult(model, 'edit_file',
    { path: '/r/b.txt', old_string: 'x', new_string: 'z', replace_all: true }, { status: 'ok' });
  assert.strictEqual(art.content, 'z\ny\nz');
});

test('#82-1 a failed edit opens nothing, and an unseen file is shown as partial, never as the whole file', async () => {
  const { createFileModel, artifactForToolResult } = await load('modules/chat/file-model.js');
  const model = createFileModel();
  artifactForToolResult(model, 'write_file', { path: '/r/c.txt', content: 'a\nb' }, { status: 'ok' });
  const failed = artifactForToolResult(model, 'edit_file',
    { path: '/r/c.txt', old_string: 'a', new_string: 'A' }, { status: 'error', error: { message: 'nope' } });
  assert.strictEqual(failed, null);

  const unseen = artifactForToolResult(model, 'edit_file',
    { path: '/r/never-seen.txt', old_string: 'a', new_string: 'A' }, { status: 'ok' });
  assert.ok(unseen);
  assert.match(unseen.title, /\(partial\)/);
});

// ---- 2. line numbers scroll with the code -------------------------------------------------

function block(css: string, selector: string): string {
  const m = css.match(new RegExp(`(^|\\n)${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`));
  return m ? m[2] : '';
}

test('#82-2 gutter and code share ONE scroll container (no nested scroller)', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const pane = html.slice(html.indexOf('id="canvasCodePane"'));
  const gutterAt = pane.indexOf('id="canvasLineNumbers"');
  const preAt = pane.indexOf('canvas-code-pre');
  assert.ok(gutterAt > 0 && preAt > gutterAt, 'gutter and pre are siblings inside the code pane');

  assert.match(block(css, '.canvas-code-pane'), /overflow:\s*auto/, 'the pane is the scroller');
  assert.doesNotMatch(block(css, '.canvas-code-pre'), /overflow:\s*auto/, 'the pre must not scroll on its own');
  assert.match(block(css, '.canvas-line-numbers'), /position:\s*sticky/, 'gutter stays pinned on horizontal scroll');
});

// ---- 3. toggle only hides --------------------------------------------------------------------

test('#82-3 toggleCanvas off then on keeps every open file', async () => {
  const mod = await load('modules/chat/canvas.js');
  const canvas = mod.createArtifactCanvas();
  canvas.openArtifact({ title: 'a.ts', filePath: '/r/a.ts', language: 'ts', content: 'A' });
  canvas.openArtifact({ title: 'b.ts', filePath: '/r/b.ts', language: 'ts', content: 'B' });

  canvas.toggleCanvas();
  assert.strictEqual(canvas.getState().isOpen, false, 'toggle hides the panel');
  assert.strictEqual(canvas.getTabs().length, 2, 'hiding must not drop tabs');

  canvas.toggleCanvas();
  assert.strictEqual(canvas.getState().isOpen, true);
  assert.deepStrictEqual(canvas.getTabs().map((t: any) => t.title), ['a.ts', 'b.ts']);
  assert.strictEqual(canvas.getState().content, 'B', 'active file content is intact');
});

test('#82-3 hideCanvas (Esc / header X) keeps tabs; closeArtifact is the explicit close-all', async () => {
  const mod = await load('modules/chat/canvas.js');
  const canvas = mod.createArtifactCanvas();
  canvas.openArtifact({ title: 'a.ts', filePath: '/r/a.ts', language: 'ts', content: 'A' });
  canvas.hideCanvas();
  assert.strictEqual(canvas.getTabs().length, 1);
  canvas.closeArtifact();
  assert.strictEqual(canvas.getTabs().length, 0);

  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const esc = app.slice(app.indexOf("// Esc stops generation"), app.indexOf("// Esc stops generation") + 900);
  assert.doesNotMatch(esc, /closeArtifact/, 'Esc must not close all tabs');
});

// ---- 4. tabs pile up, strip scrolls, active tab stays visible ---------------------------------

test('#82-4 12 files pile up as 12 tabs across turns and only closeTab removes one', async () => {
  const mod = await load('modules/chat/canvas.js');
  const canvas = mod.createArtifactCanvas();
  for (let i = 1; i <= 12; i++) {
    canvas.openArtifact({ title: `f${i}.ts`, filePath: `/r/f${i}.ts`, language: 'ts', content: `${i}` });
    if (i % 4 === 0) { canvas.toggleCanvas(); canvas.toggleCanvas(); } // a turn boundary
  }
  assert.strictEqual(canvas.getTabs().length, 12);
  canvas.closeTab('/r/f3.ts');
  assert.strictEqual(canvas.getTabs().length, 11);
  assert.ok(!canvas.getTabs().some((t: any) => t.key === '/r/f3.ts'));
});

test('#82-4 the active tab is scrolled into view, also when the panel is shown again', async () => {
  const mod = await load('modules/chat/canvas.js');
  const calls: string[] = [];
  const mkEl = (): any => ({
    className: '', textContent: '', title: '', dataset: {}, children: [] as any[],
    appendChild(c: any) { this.children.push(c); return c; },
    setAttribute() {}, addEventListener() {},
    set innerHTML(_v: string) { this.children = []; }, get innerHTML() { return ''; },
  });
  const strip = mkEl();
  strip.querySelector = () => {
    const active = strip.children.find((c: any) => /\bactive\b/.test(c.className));
    return active ? { scrollIntoView: () => calls.push(active.dataset.key) } : null;
  };
  const prev = (globalThis as any).document;
  (globalThis as any).document = { createElement: () => mkEl() };
  try {
    const canvas = mod.createArtifactCanvas({ tabStripEl: strip, canvasEl: { classList: { add() {}, remove() {}, toggle() {} } } });
    for (let i = 1; i <= 12; i++) {
      canvas.openArtifact({ title: `f${i}`, filePath: `/r/f${i}`, language: 'ts', content: 'x' });
    }
    assert.strictEqual(calls[calls.length - 1], '/r/f12', 'newest tab is revealed');
    canvas.selectTab('/r/f1');
    assert.strictEqual(calls[calls.length - 1], '/r/f1', 'selecting an off-screen tab reveals it');
    canvas.toggleCanvas();
    const before = calls.length;
    canvas.toggleCanvas();
    assert.ok(calls.length > before, 'showing the panel again re-reveals the active tab');
  } finally {
    (globalThis as any).document = prev;
  }
});
