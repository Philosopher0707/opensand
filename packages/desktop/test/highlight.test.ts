import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const hlPath = path.join(__dirname, '../../renderer/modules/chat/highlight.js');

type Token = { text: string; cls: string | null };

interface HlModule {
  TOKEN_CLASSES: string[];
  tokenize: (src: string, lang: string) => Token[];
  highlightToHtml: (src: string, lang: string) => string;
  resolveLanguageSpec: (lang: string) => { key: string; spec: Record<string, unknown> };
  countLines: (src: string) => number;
}

let cached: HlModule | null = null;
async function hl(): Promise<HlModule> {
  if (!cached) cached = (await import(pathToFileURL(hlPath).href)) as HlModule;
  return cached;
}

const textOf = (tokens: Token[]) => tokens.map((t) => t.text).join('');
const classesOf = (tokens: Token[], cls: string) =>
  tokens.filter((t) => t.cls === cls).map((t) => t.text);

test('highlighter - tokenizing is lossless for every supported language', { timeout: 10000 }, async () => {
  const { tokenize } = await hl();
  const samples: Record<string, string> = {
    typescript: 'const x: number = 42; // note\nfunction f(a: string) { return `v=${a}`; }',
    python: 'def f(x):\n    """doc"""\n    return x + 1  # note\n',
    json: '{"a": 1, "b": [true, false, null]}',
    css: '.a { color: #fff; /* c */ }',
    html: '<div class="x" data-y=\'1\'>text</div>',
    bash: 'if [ -f "$f" ]; then echo hi; fi',
    sql: 'SELECT id FROM t WHERE a = 1',
    diff: '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y',
    markdown: '# Title\n\n`code`',
    xml: '<a><b/></a>',
  };
  for (const [lang, src] of Object.entries(samples)) {
    assert.strictEqual(textOf(tokenize(src, lang)), src, `lossless round-trip failed for ${lang}`);
  }
});

test('highlighter - a keyword inside a string or comment is not coloured as a keyword', { timeout: 10000 }, async () => {
  const { tokenize } = await hl();
  // This is the failure mode that makes naive highlighters look broken.
  const tokens = tokenize('const s = "const return if";', 'typescript');
  const strings = classesOf(tokens, 'string');
  assert.strictEqual(strings.length, 1);
  assert.strictEqual(strings[0], '"const return if"');
  // Exactly one keyword: the leading `const`.
  assert.deepStrictEqual(classesOf(tokens, 'keyword'), ['const']);

  const withComment = tokenize('// function return\nlet x = 1;', 'typescript');
  assert.deepStrictEqual(classesOf(withComment, 'comment'), ['// function return']);
  assert.deepStrictEqual(classesOf(withComment, 'keyword'), ['let']);
});

test('highlighter - classifies the main token kinds', { timeout: 10000 }, async () => {
  const { tokenize } = await hl();
  const src = 'const n = 42;\nfunction greet(name) { return name; }';
  const tokens = tokenize(src, 'typescript');

  assert.deepStrictEqual(classesOf(tokens, 'keyword'), ['const', 'function', 'return']);
  assert.deepStrictEqual(classesOf(tokens, 'number'), ['42']);
  // greet( is a call, and name is a parameter — greet should read as a function.
  assert.ok(classesOf(tokens, 'function').includes('greet'));
  assert.ok(classesOf(tokens, 'punct').includes('('));
  assert.ok(classesOf(tokens, 'operator').includes('='));
});

test('highlighter - python comments, triple strings and decorators', { timeout: 10000 }, async () => {
  const { tokenize } = await hl();
  const src = '@decorator\ndef f():\n    """docstring"""\n    return None  # done';
  const tokens = tokenize(src, 'python');

  assert.deepStrictEqual(classesOf(tokens, 'comment'), ['# done']);
  assert.ok(classesOf(tokens, 'string').includes('"""docstring"""'));
  assert.ok(classesOf(tokens, 'function').includes('@decorator'));
  assert.deepStrictEqual(classesOf(tokens, 'constant'), ['None']);
});

test('highlighter - markdown/plain text is not mangled', { timeout: 10000 }, async () => {
  const { tokenize } = await hl();
  const plain = 'just some prose\nwith two lines';
  const tokens = tokenize(plain, 'text');
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(tokens[0].cls, null);
  assert.strictEqual(tokens[0].text, plain);
});

test('highlighter - unknown languages fall back to plain text, never throw', { timeout: 10000 }, async () => {
  const { tokenize, resolveLanguageSpec } = await hl();
  assert.strictEqual(resolveLanguageSpec('brainfuck').key, 'text');
  const tokens = tokenize('+++.', 'brainfuck');
  assert.strictEqual(textOf(tokens), '+++.');
});

test('highlighter - aliases resolve to a real grammar', { timeout: 10000 }, async () => {
  const { resolveLanguageSpec } = await hl();
  assert.strictEqual(resolveLanguageSpec('ts').key, 'javascript');
  assert.strictEqual(resolveLanguageSpec('tsx').key, 'javascript');
  assert.strictEqual(resolveLanguageSpec('py').key, 'python');
  assert.strictEqual(resolveLanguageSpec('yml').key, 'yaml');
  assert.strictEqual(resolveLanguageSpec('.rs').key, 'rust');
  assert.strictEqual(resolveLanguageSpec('sh').key, 'bash');
});

test('highlighter - HTML output is escaped, so it is safe for innerHTML', { timeout: 10000 }, async () => {
  const { highlightToHtml } = await hl();
  const dangerous = 'const x = "<img src=x onerror=alert(1)>"; // <script>';
  const html = highlightToHtml(dangerous, 'typescript');

  assert.ok(!html.includes('<img'), 'raw tag must not survive');
  assert.ok(!html.includes('<script>'), 'raw script must not survive');
  assert.ok(html.includes('&lt;img'), 'tag should be escaped, not dropped');
  // The escaped text still round-trips when unescaped.
  const stripped = html.replace(/<[^>]+>/g, '');
  assert.ok(stripped.includes('&lt;img'));
});

test('highlighter - every emitted class is a declared token class', { timeout: 10000 }, async () => {
  const { tokenize, TOKEN_CLASSES } = await hl();
  const samples = [
    'const a = 1; // c',
    '<div class="x">hi</div>',
    'SELECT * FROM t -- c',
    '--- a\n+++ b\n@@ -1 +1 @@',
    'def f(): return "s"',
  ];
  const allowed = new Set(TOKEN_CLASSES);
  for (const src of samples) {
    for (const lang of ['typescript', 'html', 'sql', 'diff', 'python']) {
      for (const t of tokenize(src, lang)) {
        if (t.cls !== null) {
          assert.ok(allowed.has(t.cls), `undeclared token class: ${t.cls}`);
        }
      }
    }
  }
});

test('highlighter - handles empty input and unterminated literals without throwing', { timeout: 10000 }, async () => {
  const { tokenize, highlightToHtml } = await hl();
  assert.strictEqual(textOf(tokenize('', 'typescript')), '');
  // Unterminated string, block comment, and template.
  assert.strictEqual(textOf(tokenize('const a = "unterminated', 'typescript')), 'const a = "unterminated');
  assert.strictEqual(textOf(tokenize('/* never closed', 'typescript')), '/* never closed');
  assert.strictEqual(textOf(tokenize('`open template', 'typescript')), '`open template');
  assert.strictEqual(highlightToHtml('', 'typescript'), '');
});

test('highlighter - multi-line CSS gets property tokens', async () => {
  const { tokenize, highlightToHtml } = await hl();
  const css = '.btn {\n  color: #fff;\n  margin: 0 auto;\n}';
  const tokens = tokenize(css, 'css');
  assert.deepStrictEqual(classesOf(tokens, 'property'), ['color', 'margin']);
  assert.ok(highlightToHtml(css, 'css').includes('tok-property'));
});

test('highlighter - a bare # does not hang the tokenizer (markdown headings)', async () => {
  // `#` is an identifier start but not an identifier part, so an unguarded scan
  // produced a zero-length word and never advanced. This test fails by hanging.
  const { tokenize } = await hl();
  const cases = ['# Title', '## Sub', '#', 'a # b', '@', '## `x` ##'];
  for (const src of cases) {
    assert.strictEqual(textOf(tokenize(src, 'markdown')), src);
    assert.strictEqual(textOf(tokenize(src, 'text')), src);
  }
});

