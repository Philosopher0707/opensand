/**
 * A small, dependency-free syntax highlighter.
 *
 * Why hand-rolled: the renderer is plain ESM loaded directly by the browser —
 * there is no bundler and no highlighter library in `package.json`. Adding one
 * would mean introducing a build step for a single feature. This covers the
 * languages the canvas actually shows, using an ordered tokenizer rather than a
 * grammar engine: comments and strings are matched first so a keyword inside a
 * string is not mis-coloured, which is the failure mode that makes naive
 * highlighting look broken.
 *
 * Every token class is emitted as a `<span class="tok-...">`, and the colours
 * live in CSS as theme variables so light and dark both read correctly.
 */

/** Token classes. Kept small — more classes than this stops being readable. */
export const TOKEN_CLASSES = [
  'comment',
  'string',
  'number',
  'keyword',
  'type',
  'function',
  'property',
  'operator',
  'punct',
  'tag',
  'attr',
  'constant',
];

/**
 * Token shape: { text, cls }. `cls` is one of TOKEN_CLASSES or null for plain
 * text. This is plain JS — the renderer is loaded directly by the browser.
 */

const JS_KEYWORDS = [
  'const', 'let', 'var', 'function', 'class', 'extends', 'implements', 'interface', 'enum',
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'new', 'this', 'super', 'typeof', 'instanceof', 'in', 'of', 'await', 'async', 'yield',
  'try', 'catch', 'finally', 'throw', 'import', 'export', 'from', 'default', 'as',
  'public', 'private', 'protected', 'readonly', 'static', 'abstract', 'declare', 'namespace',
  'type', 'satisfies', 'keyof', 'infer', 'is', 'void', 'delete', 'with', 'debugger',
];

const JS_CONSTANTS = ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'];

const PY_KEYWORDS = [
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue',
  'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'pass', 'lambda',
  'yield', 'await', 'async', 'global', 'nonlocal', 'assert', 'del', 'in', 'is', 'not',
  'and', 'or', 'match', 'case', 'self', 'cls',
];

const PY_CONSTANTS = ['True', 'False', 'None', 'NotImplemented', 'Ellipsis'];

const GO_KEYWORDS = [
  'package', 'import', 'func', 'return', 'if', 'else', 'for', 'range', 'switch', 'case',
  'default', 'break', 'continue', 'type', 'struct', 'interface', 'map', 'chan', 'go',
  'defer', 'select', 'var', 'const', 'nil', 'true', 'false', 'fallthrough', 'goto',
];

const RUST_KEYWORDS = [
  'fn', 'let', 'mut', 'const', 'struct', 'enum', 'impl', 'trait', 'pub', 'use', 'mod',
  'return', 'if', 'else', 'match', 'for', 'while', 'loop', 'break', 'continue', 'move',
  'async', 'await', 'dyn', 'where', 'crate', 'self', 'super', 'unsafe', 'ref', 'type',
];

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'TABLE', 'INDEX', 'ALTER', 'DROP', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER',
  'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'AS', 'AND', 'OR', 'NOT',
  'NULL', 'DISTINCT', 'UNION', 'ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'BEGIN',
  'COMMIT', 'ROLLBACK', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'DEFAULT',
];

const SHELL_KEYWORDS = [
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until',
  'case', 'esac', 'function', 'return', 'export', 'local', 'readonly', 'source',
  'alias', 'unset', 'shift', 'trap', 'set', 'eval', 'exec',
];

const SPECS = {
  javascript: {
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    strings: [{ open: '"', close: '"' }, { open: "'", close: "'" }, { open: '`', close: '`', multiline: true }],
    keywords: JS_KEYWORDS,
    constants: JS_CONSTANTS,
    decorators: true,
  },
  python: {
    lineComment: ['#'],
    strings: [{ open: '"""', close: '"""', multiline: true }, { open: "'''", close: "'''", multiline: true }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    keywords: PY_KEYWORDS,
    constants: PY_CONSTANTS,
    decorators: true,
  },
  go: {
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    strings: [{ open: '"', close: '"' }, { open: '`', close: '`', multiline: true }],
    keywords: GO_KEYWORDS,
  },
  rust: {
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    strings: [{ open: '"', close: '"' }],
    keywords: RUST_KEYWORDS,
  },
  java: {
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    strings: [{ open: '"', close: '"' }],
    keywords: [...JS_KEYWORDS, 'public', 'protected', 'void', 'final', 'throws', 'synchronized'],
    constants: JS_CONSTANTS,
    decorators: true,
  },
  c: {
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    strings: [{ open: '"', close: '"' }],
    keywords: ['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break',
      'continue', 'return', 'struct', 'union', 'enum', 'typedef', 'static', 'extern',
      'const', 'volatile', 'sizeof', 'goto', 'inline', 'unsigned', 'signed'],
  },
  sql: {
    lineComment: ['--'],
    blockComment: ['/*', '*/'],
    strings: [{ open: "'", close: "'" }],
    keywords: SQL_KEYWORDS,
  },
  bash: {
    lineComment: ['#'],
    strings: [{ open: '"', close: '"' }, { open: "'", close: "'" }],
    keywords: SHELL_KEYWORDS,
  },
  yaml: {
    lineComment: ['#'],
    strings: [{ open: '"', close: '"' }, { open: "'", close: "'" }],
    constants: ['true', 'false', 'null', 'yes', 'no', 'on', 'off'],
  },
  json: {
    strings: [{ open: '"', close: '"' }],
    constants: ['true', 'false', 'null'],
  },
  css: {
    blockComment: ['/*', '*/'],
    strings: [{ open: '"', close: '"' }, { open: "'", close: "'" }],
  },
  html: {
    blockComment: ['<!--', '-->'],
    strings: [{ open: '"', close: '"' }, { open: "'", close: "'" }],
  },
  markdown: {
    lineComment: ['> '],
    strings: [{ open: '`', close: '`' }],
  },
  diff: {},
  text: {},
};

/** Map the many aliases the canvas can produce onto a spec key. */
const ALIASES = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'javascript', tsx: 'javascript', typescript: 'javascript', javascript: 'javascript',
  py: 'python', python: 'python',
  rs: 'rust', rust: 'rust',
  golang: 'go', go: 'go',
  kt: 'java', kts: 'java', java: 'java', swift: 'java', cs: 'java', csharp: 'java',
  c: 'c', h: 'c', cpp: 'c', 'c++': 'c', hpp: 'c', m: 'c', mm: 'c',
  sql: 'sql', psql: 'sql', mysql: 'sql', sqlite: 'sql',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash', console: 'bash',
  yml: 'yaml', yaml: 'yaml',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  md: 'markdown', markdown: 'markdown',
  diff: 'diff', patch: 'diff',
  text: 'text', txt: 'text', plaintext: 'text',
};

export function resolveLanguageSpec(lang) {
  const raw = String(lang || '').toLowerCase().trim().replace(/^\./, '');
  const key = ALIASES[raw] || 'text';
  return { key, spec: SPECS[key] || {} };
}

const IDENT_START = /[A-Za-z_$@#]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

/**
 * Tokenize `source` for `lang`. Produces a flat list of { text, cls } covering
 * the input exactly once, so a caller can concatenate the text back and get the
 * original source (asserted in tests).
 */
export function tokenize(source, lang) {
  const text = String(source ?? '');
  const { key, spec } = resolveLanguageSpec(lang);

  if (key === 'text') return [{ text, cls: null }];
  if (key === 'diff') return tokenizeDiff(text);
  if (key === 'html') return tokenizeMarkup(text, spec);
  if (key === 'css') return tokenizeCss(text, spec);

  const keywords = new Set(spec.keywords || []);
  const constants = new Set(spec.constants || []);
  const types = new Set(spec.types || []);

  const tokens = [];
  let i = 0;
  let plain = '';

  const flush = () => {
    if (plain) {
      tokens.push({ text: plain, cls: null });
      plain = '';
    }
  };
  const push = (cls, value) => {
    flush();
    tokens.push({ text: value, cls });
  };

  while (i < text.length) {
    const rest = text.slice(i);

    // Block comment
    if (spec.blockComment) {
      const [open, close] = spec.blockComment;
      if (rest.startsWith(open)) {
        const end = text.indexOf(close, i + open.length);
        const stop = end === -1 ? text.length : end + close.length;
        push('comment', text.slice(i, stop));
        i = stop;
        continue;
      }
    }

    // Line comment
    if (spec.lineComment) {
      const hit = spec.lineComment.find((c) => rest.startsWith(c));
      if (hit) {
        const nl = text.indexOf('\n', i);
        const stop = nl === -1 ? text.length : nl;
        push('comment', text.slice(i, stop));
        i = stop;
        continue;
      }
    }

    // Strings — longest opener first so """ wins over ".
    if (spec.strings) {
      const ordered = [...spec.strings].sort((a, b) => b.open.length - a.open.length);
      const hit = ordered.find((s) => rest.startsWith(s.open));
      if (hit) {
        let j = i + hit.open.length;
        while (j < text.length) {
          if (text.startsWith(hit.close, j)) {
            j += hit.close.length;
            break;
          }
          // An unterminated single-line string stops at the newline.
          if (!hit.multiline && text[j] === '\n') break;
          if (text[j] === '\\' && hit.open !== '`') {
            j += 2;
            continue;
          }
          j += 1;
        }
        push('string', text.slice(i, j));
        i = j;
        continue;
      }
    }

    const ch = text[i];

    // Numbers, including 0x, underscores, decimals, exponents
    if (DIGIT.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9a-fA-FxXoObB._]/.test(text[j])) j += 1;
      if (j < text.length && /[eE]/.test(text[j])) {
        j += 1;
        if (text[j] === '+' || text[j] === '-') j += 1;
        while (j < text.length && DIGIT.test(text[j])) j += 1;
      }
      push('number', text.slice(i, j));
      i = j;
      continue;
    }

    // Identifiers / keywords / calls / types
    if (IDENT_START.test(ch)) {
      let j = i;
      // Python decorators and Ruby-ish @annotations
      if ((ch === '@' || ch === '#') && spec.decorators) {
        j += 1;
        while (j < text.length && (IDENT_PART.test(text[j]) || text[j] === '.')) j += 1;
        push('function', text.slice(i, j));
        i = j;
        continue;
      }
      while (j < text.length && IDENT_PART.test(text[j])) j += 1;
      // `#` and `@` are identifier *starts* but not identifier *parts*, so a bare
      // one (markdown headings, say) yields a zero-length word. Without this
      // guard the index never advances and the tokenizer loops forever.
      if (j === i) {
        plain += ch;
        i += 1;
        continue;
      }
      const word = text.slice(i, j);

      // Full-line `#!` shebang already handled by line comments; skip here.

      const prevToken = tokens.length ? tokens[tokens.length - 1] : null;
      const afterDot =
        prevToken !== null &&
        prevToken.cls === 'punct' &&
        /\.$/.test(prevToken.text) === false &&
        plain.trim().endsWith('.');

      // Peek past whitespace for a call paren.
      let k = j;
      while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k += 1;
      const isCall = text[k] === '(';

      if (keywords.has(word)) {
        push('keyword', word);
      } else if (afterDot) {
        push('property', word);
      } else if (constants.has(word)) {
        push('constant', word);
      } else if (isCall) {
        push('function', word);
      } else if (types.has(word) || /^[A-Z][A-Za-z0-9_]*$/.test(word)) {
        push('type', word);
      } else {
        plain += word;
      }
      i = j;
      continue;
    }

    // Operators and punctuation
    if (/[+\-*/%=<>!&|^~?:]/.test(ch)) {
      let j = i;
      while (j < text.length && /[+\-*/%=<>!&|^~?:]/.test(text[j])) j += 1;
      push('operator', text.slice(i, j));
      i = j;
      continue;
    }
    if (/[{}[\]();,.]/.test(ch)) {
      push('punct', ch);
      i += 1;
      continue;
    }

    plain += ch;
    i += 1;
  }

  flush();
  return tokens;
}

/** Diff: colour per line, which is the only useful granularity. */
function tokenizeDiff(text) {
  const tokens = [];
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    let cls = null;
    if (/^(\+\+\+|---)/.test(line)) cls = 'comment';
    else if (/^@@/.test(line)) cls = 'type';
    else if (line.startsWith('+')) cls = 'keyword';
    else if (line.startsWith('-')) cls = 'string';
    else if (/^(diff|index|new file|deleted file|similarity|rename)/.test(line)) cls = 'constant';
    tokens.push({ text: line, cls });
    if (idx < lines.length - 1) tokens.push({ text: '\n', cls: null });
  });
  return tokens;
}

/** HTML/XML: tags, attribute names, attribute values, comments. */
function tokenizeMarkup(text, spec) {
  const tokens = [];
  const push = (cls, value) => tokens.push({ text: value, cls });
  let i = 0;
  let plain = '';
  const flush = () => {
    if (plain) {
      push(null, plain);
      plain = '';
    }
  };

  while (i < text.length) {
    if (spec.blockComment && text.startsWith(spec.blockComment[0], i)) {
      const end = text.indexOf(spec.blockComment[1], i + 4);
      const stop = end === -1 ? text.length : end + spec.blockComment[1].length;
      flush();
      push('comment', text.slice(i, stop));
      i = stop;
      continue;
    }
    if (text[i] === '<') {
      const close = text.indexOf('>', i);
      const stop = close === -1 ? text.length : close + 1;
      const inside = text.slice(i, stop);
      flush();
      // Split the tag into name / attrs / values.
      const m = inside.match(/^(<\/?)([A-Za-z0-9!:_-]+)([\s\S]*?)(\/?>)$/);
      if (!m) {
        push('tag', inside);
      } else {
        push('punct', m[1]);
        push('tag', m[2]);
        let restAttrs = m[3];
        while (restAttrs.length) {
          const am = restAttrs.match(/^(\s+)([A-Za-z_:][\w:.-]*)(\s*=\s*)?("[^"]*"|'[^']*'|[^\s>]+)?/);
          if (!am) {
            push(null, restAttrs);
            break;
          }
          push(null, am[1]);
          push('attr', am[2]);
          if (am[3]) push('operator', am[3]);
          if (am[4]) push('string', am[4]);
          restAttrs = restAttrs.slice(am[0].length);
        }
        push('punct', m[4]);
      }
      i = stop;
      continue;
    }
    plain += text[i];
    i += 1;
  }
  flush();
  return tokens;
}

/** CSS: selectors, properties, values, comments. */
function tokenizeCss(text, spec) {
  const tokens = [];
  const push = (cls, value) => tokens.push({ text: value, cls });
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    const comment = line.match(/\/\*[\s\S]*?\*\//);
    if (comment) {
      const parts = line.split(comment[0]);
      if (parts[0]) push(null, parts[0]);
      push('comment', comment[0]);
      if (parts[1]) push(null, parts[1]);
    } else {
      const prop = line.match(/^(\s*)([-A-Za-z]+)(\s*:)([\s\S]*)$/);
      if (prop) {
        push(null, prop[1]);
        push('property', prop[2]);
        push('operator', prop[3]);
        const value = prop[4];
        const strMatch = value.match(/^(\s*)("[^"]*"|'[^']*')/);
        if (strMatch) {
          push(null, strMatch[1]);
          push('string', strMatch[2]);
          push('constant', value.slice(strMatch[0].length));
        } else {
          push('constant', value);
        }
      } else if (/^\s*[.#@:\[a-zA-Z*]/.test(line) && /\{$/.test(line.trim())) {
        push('tag', line);
      } else {
        push(null, line);
      }
    }
    if (idx < lines.length - 1) push(null, '\n');
  });
  return tokens;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Highlight `source` into HTML. The output is safe to assign to innerHTML:
 * every token's text is escaped before being wrapped.
 */
export function highlightToHtml(source, lang) {
  const tokens = tokenize(source, lang);
  return tokens
    .map((t) => (t.cls ? `<span class="tok-${t.cls}">${escapeHtml(t.text)}</span>` : escapeHtml(t.text)))
    .join('');
}

/** Line count, used to keep the gutter in sync with the highlighted body. */
export function countLines(source) {
  const text = String(source ?? '');
  return text === '' ? 1 : (text.match(/\n/g) || []).length + 1;
}
