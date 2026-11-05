import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const canvasModulePath = path.join(__dirname, '../../renderer/modules/chat/canvas.js');

// A dynamic import of a computed path yields `any`, so the declared controller
// interface is applied here rather than sprinkling annotations through the tests.
type ArtifactTab = { key: string; title: string; filePath: string; language: string; active: boolean; hasDiff: boolean };
type ArtifactCanvasController = {
  getState: () => { isOpen: boolean; activeTab: 'code' | 'preview' | 'diff'; title: string; content: string; diff: string };
  getTabs: () => ArtifactTab[];
  openArtifact: (artifact?: Record<string, unknown>) => void;
  closeArtifact: () => void;
  closeTab: (key: string) => void;
  selectTab: (key: string) => void;
  nextTab: (delta: number) => void;
};

async function loadCanvas(): Promise<ArtifactCanvasController> {
  const mod = await import(pathToFileURL(canvasModulePath).href);
  return mod.createArtifactCanvas() as ArtifactCanvasController;
}

test('Artifact Canvas tabs - each written file accumulates as its own tab', async () => {
  const canvas = await loadCanvas();

  canvas.openArtifact({ title: 'a.ts', filePath: '/repo/a.ts', language: 'typescript', content: 'const a = 1;' });
  canvas.openArtifact({ title: 'b.ts', filePath: '/repo/b.ts', language: 'typescript', content: 'const b = 2;' });
  canvas.openArtifact({ title: 'c.md', filePath: '/repo/c.md', language: 'markdown', content: '# C' });

  const tabs = canvas.getTabs();
  assert.strictEqual(tabs.length, 3, 'three files should yield three tabs');
  assert.deepStrictEqual(tabs.map((t) => t.title), ['a.ts', 'b.ts', 'c.md']);
  // The most recently opened file is the active one.
  assert.strictEqual(tabs[2].active, true);
  assert.strictEqual(canvas.getState().title, 'c.md');
  assert.strictEqual(canvas.getState().content, '# C');
});

test('Artifact Canvas tabs - re-opening the same path updates in place, no duplicate', async () => {
  const canvas = await loadCanvas();

  canvas.openArtifact({ title: 'a.ts', filePath: '/repo/a.ts', language: 'typescript', content: 'v1' });
  canvas.openArtifact({ title: 'b.ts', filePath: '/repo/b.ts', language: 'typescript', content: 'b' });
  canvas.openArtifact({ title: 'a.ts', filePath: '/repo/a.ts', language: 'typescript', content: 'v2' });

  const tabs = canvas.getTabs();
  assert.strictEqual(tabs.length, 2, 'the same path must not open a second tab');
  assert.strictEqual(tabs[0].title, 'a.ts');
  assert.strictEqual(tabs[1].title, 'b.ts');

  canvas.selectTab('/repo/a.ts');
  assert.strictEqual(canvas.getState().content, 'v2', 'content should be the latest write');
});

test('Artifact Canvas tabs - editing one file does not clobber another tab', async () => {
  const canvas = await loadCanvas();

  canvas.openArtifact({ title: 'a.ts', filePath: '/repo/a.ts', language: 'typescript', content: 'A-contents' });
  canvas.openArtifact({ title: 'b.ts', filePath: '/repo/b.ts', language: 'typescript', content: 'B-contents' });

  // Simulate an edit_file event for b.ts while a.ts exists.
  canvas.openArtifact({
    title: 'b.ts (edit)',
    filePath: '/repo/b.ts',
    language: 'typescript',
    content: 'B-new',
    diff: '--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-B-contents\n+B-new',
    defaultTab: 'diff',
  });

  // b.ts now shows its diff...
  assert.strictEqual(canvas.getState().title, 'b.ts (edit)');
  assert.strictEqual(canvas.getState().activeTab, 'diff');

  // ...and a.ts is untouched, still holding its own content.
  canvas.selectTab('/repo/a.ts');
  assert.strictEqual(canvas.getState().content, 'A-contents');
  assert.strictEqual(canvas.getState().activeTab, 'code');
});

test('Artifact Canvas tabs - closing a tab activates a neighbour, closing all hides canvas', async () => {
  const canvas = await loadCanvas();

  canvas.openArtifact({ title: 'a.ts', filePath: '/repo/a.ts', language: 'typescript', content: 'a' });
  canvas.openArtifact({ title: 'b.ts', filePath: '/repo/b.ts', language: 'typescript', content: 'b' });
  canvas.openArtifact({ title: 'c.ts', filePath: '/repo/c.ts', language: 'typescript', content: 'c' });

  // Close the active (c).
  canvas.closeTab('/repo/c.ts');
  assert.strictEqual(canvas.getTabs().length, 2);
  assert.strictEqual(canvas.getState().title, 'b.ts', 'should fall back to the neighbour');

  assert.strictEqual(canvas.getState().isOpen, true);
  canvas.closeTab('/repo/a.ts');
  canvas.closeTab('/repo/b.ts');
  assert.strictEqual(canvas.getTabs().length, 0);
  assert.strictEqual(canvas.getState().isOpen, false, 'closing the last tab closes the canvas');
});

test('Artifact Canvas tabs - closing an inactive tab keeps the active one', async () => {
  const canvas = await loadCanvas();

  canvas.openArtifact({ title: 'a.ts', filePath: '/repo/a.ts', language: 'typescript', content: 'a' });
  canvas.openArtifact({ title: 'b.ts', filePath: '/repo/b.ts', language: 'typescript', content: 'b' });

  canvas.closeTab('/repo/a.ts');
  assert.strictEqual(canvas.getTabs().length, 1);
  assert.strictEqual(canvas.getState().title, 'b.ts');
});

test('Artifact Canvas tabs - each tab remembers its own view mode', async () => {
  const canvas = await loadCanvas();

  canvas.openArtifact({ title: 'a.md', filePath: '/repo/a.md', language: 'markdown', content: '# A', autoPreview: true });
  assert.strictEqual(canvas.getState().activeTab, 'preview');

  canvas.openArtifact({ title: 'b.ts', filePath: '/repo/b.ts', language: 'typescript', content: 'b' });
  assert.strictEqual(canvas.getState().activeTab, 'code');

  // Returning to a.md should restore its preview view, not force code.
  canvas.selectTab('/repo/a.md');
  assert.strictEqual(canvas.getState().activeTab, 'preview');
});

test('Artifact Canvas tabs - nextTab cycles through open files', async () => {
  const canvas = await loadCanvas();

  canvas.openArtifact({ title: 'a.ts', filePath: '/repo/a.ts', language: 'typescript', content: 'a' });
  canvas.openArtifact({ title: 'b.ts', filePath: '/repo/b.ts', language: 'typescript', content: 'b' });
  canvas.openArtifact({ title: 'c.ts', filePath: '/repo/c.ts', language: 'typescript', content: 'c' });

  canvas.nextTab(-1);
  assert.strictEqual(canvas.getState().title, 'b.ts');
  canvas.nextTab(-1);
  assert.strictEqual(canvas.getState().title, 'a.ts');
  canvas.nextTab(-1);
  assert.strictEqual(canvas.getState().title, 'c.ts', 'should wrap around');
});

test('Artifact Canvas tabs - tabs without a filePath are keyed by title', async () => {
  const canvas = await loadCanvas();

  canvas.openArtifact({ title: 'Working Tree Diff', language: 'diff', content: 'd', diff: 'd', defaultTab: 'diff' });
  canvas.openArtifact({ title: 'Working Tree Diff', language: 'diff', content: 'd2', diff: 'd2', defaultTab: 'diff' });

  assert.strictEqual(canvas.getTabs().length, 1, 'a title-keyed artifact should also update in place');
});

/**
 * Minimal DOM stub. The renderer is plain JS running in a browser, so without a
 * DOM library the tab strip is untested. Rather than add jsdom for one module,
 * this stands up just enough structure to assert what renderTabStrip() builds and
 * that the delegated click handler routes correctly.
 */
function makeStubEl(tag = 'div'): any {
  const el: any = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    title: '',
    type: '',
    children: [] as any[],
    dataset: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    listeners: {} as Record<string, Array<(ev: any) => void>>,
    appendChild(child: any) {
      this.children.push(child);
      return child;
    },
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    get innerHTML() {
      return '';
    },
    set innerHTML(_v: string) {
      this.children = [];
    },
    addEventListener(type: string, fn: (ev: any) => void) {
      (this.listeners[type] ||= []).push(fn);
    },
    dispatch(type: string, ev: any) {
      for (const fn of this.listeners[type] || []) fn(ev);
    },
    closest(sel: string) {
      // Supports the selector forms the canvas actually uses:
      //   '.class'                    -> className match
      //   '[data-attr]' / '[...="v"]' -> dataset attribute match
      //   'div'                       -> tag name
      let node: any = this;
      while (node) {
        if (sel.startsWith('.')) {
          const want = sel.slice(1);
          if (String(node.className || '').split(/\s+/).includes(want)) return node;
        } else if (sel.startsWith('[')) {
          const m = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
          if (m) {
            const attr = m[1];
            const expected = m[2];
            // data-close-key -> dataset.closeKey (strip the data- prefix first)
            const camel = attr
              .replace(/^data-/, '')
              .replace(/-([a-z])/g, (_x: string, c: string) => c.toUpperCase());
            const val = node.dataset ? node.dataset[camel] : undefined;
            if (val !== undefined && (expected === undefined || val === expected)) return node;
          }
        } else if (node.tagName && node.tagName.toLowerCase() === sel.toLowerCase()) {
          return node;
        }
        node = node.parent;
      }
      return null;
    },
  };
  return el;
}

async function makeCanvasWithStrip() {
  const mod = await import(pathToFileURL(canvasModulePath).href);
  const strip = makeStubEl();
  // Track parents so closest() can walk up.
  const origAppend = strip.appendChild.bind(strip);
  strip.appendChild = (child: any) => {
    child.parent = strip;
    return origAppend(child);
  };
  const g: any = globalThis as any;
  const prevDoc = g.document;
  g.document = { createElement: (tag: string) => makeStubEl(tag) };
  const canvas = mod.createArtifactCanvas({ tabStripEl: strip });
  return { canvas, strip, restore: () => { g.document = prevDoc; } };
}

test('Artifact Canvas tabs - tab strip renders one element per open file', async () => {
  const { canvas, strip, restore } = await makeCanvasWithStrip();
  try {
    canvas.openArtifact({ title: 'a.ts', filePath: '/repo/a.ts', language: 'typescript', content: 'a' });
    canvas.openArtifact({ title: 'b.ts', filePath: '/repo/b.ts', language: 'typescript', content: 'b' });

    assert.strictEqual(strip.children.length, 2, 'strip should hold two tabs');

    const first = strip.children[0];
    assert.match(first.className, /canvas-file-tab/);
    assert.ok(!/active/.test(first.className), 'first tab is not active');
    assert.match(strip.children[1].className, /active/, 'most recent tab is active');

    // Each tab carries an icon, a label, and a close button.
    const label = first.children.find((c: any) => /canvas-file-tab-label/.test(c.className));
    assert.strictEqual(label.textContent, 'a.ts');
    const close = first.children.find((c: any) => /canvas-file-tab-close/.test(c.className));
    assert.ok(close, 'tab has a close button');
    assert.strictEqual(close.dataset.closeKey, '/repo/a.ts');
  } finally {
    restore();
  }
});

test('Artifact Canvas tabs - clicking a tab selects it, clicking close removes it', async () => {
  const { canvas, strip, restore } = await makeCanvasWithStrip();
  try {
    canvas.openArtifact({ title: 'a.ts', filePath: '/repo/a.ts', language: 'typescript', content: 'a' });
    canvas.openArtifact({ title: 'b.ts', filePath: '/repo/b.ts', language: 'typescript', content: 'b' });
    assert.strictEqual(canvas.getState().title, 'b.ts');

    // Click the first tab.
    const firstTab = strip.children[0];
    strip.dispatch('click', { target: firstTab, stopPropagation() {} });
    assert.strictEqual(canvas.getState().title, 'a.ts', 'click should focus the tab');

    // Click its close button.
    const closeBtn = strip.children[0].children.find((c: any) => /canvas-file-tab-close/.test(c.className));
    strip.dispatch('click', { target: closeBtn, stopPropagation() {} });
    assert.strictEqual(canvas.getTabs().length, 1, 'close button should remove the tab');
    assert.strictEqual(canvas.getTabs()[0].title, 'b.ts');
  } finally {
    restore();
  }
});

test('Artifact Canvas tabs - an explicit key gives distinct tabs despite a shared title', async () => {
  const canvas = await loadCanvas();

  // Two JS snippets share a title; without a key they would collapse into one.
  canvas.openArtifact({ key: 'snippet:js:1', title: 'JS Snippet', language: 'javascript', content: 'one' });
  canvas.openArtifact({ key: 'snippet:js:2', title: 'JS Snippet', language: 'javascript', content: 'two' });

  const tabs = canvas.getTabs();
  assert.strictEqual(tabs.length, 2, 'explicit keys must not collapse');
  assert.strictEqual(canvas.getState().content, 'two');

  canvas.selectTab('snippet:js:1');
  assert.strictEqual(canvas.getState().content, 'one');
});

test('Artifact Canvas tabs - a title-keyed diff replaces itself rather than accumulating', async () => {
  const canvas = await loadCanvas();

  canvas.openArtifact({ title: 'Working Tree Diff', language: 'diff', content: 'd1', diff: 'd1', defaultTab: 'diff' });
  canvas.openArtifact({ title: 'Working Tree Diff', language: 'diff', content: 'd2', diff: 'd2', defaultTab: 'diff' });

  const tabs = canvas.getTabs();
  assert.strictEqual(tabs.length, 1, 'repeated diffs should not pile up');
  assert.strictEqual(canvas.getState().diff, 'd2');
});
