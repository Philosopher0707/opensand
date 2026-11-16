// file-model.js — what the Artifact Canvas knows about files the agent touched.
//
// The engine's edit_file result reports only path/count/sha, never the file, and the
// desktop bridge has no read API. So the renderer keeps the last full content it has
// seen per path (from write_file, or an unbounded read_file) and applies each
// successful edit to it. When a file was never seen in full, `applyEdit` returns null
// and the caller shows the changed snippet, labelled as partial, instead of lying.

const TRUNCATION_MARK = '[... File truncated:';

export function isFailedResult(result) {
  if (!result || typeof result !== 'object') return false;
  return result.status === 'error' || Boolean(result.error);
}

function unwrapOutput(result) {
  if (result && typeof result === 'object' && result.output && typeof result.output === 'object') {
    return result.output;
  }
  return result;
}

/**
 * Unified diff for a single contiguous change (common prefix/suffix trimmed),
 * with real line numbers and `context` lines around it.
 */
export function buildUnifiedDiff(before, after, fileName, context = 3) {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - context);
  const toA = Math.min(a.length, endA + context);
  const toB = Math.min(b.length, endB + context);
  const out = [`--- a/${fileName}`, `+++ b/${fileName}`];
  out.push(`@@ -${from + 1},${toA - from} +${from + 1},${toB - from} @@`);
  for (let i = from; i < start; i++) out.push(` ${a[i]}`);
  for (let i = start; i < endA; i++) out.push(`-${a[i]}`);
  for (let i = start; i < endB; i++) out.push(`+${b[i]}`);
  for (let i = endA; i < toA; i++) out.push(` ${a[i]}`);
  return out.join('\n');
}

export function createFileModel() {
  const files = new Map();

  function remember(path, content) {
    files.set(String(path), String(content));
  }

  function recordRead(args, result) {
    if (!args || !args.path || isFailedResult(result)) return;
    // A ranged or truncated read is not the file.
    if (args.start_line !== undefined || args.end_line !== undefined) return;
    const out = unwrapOutput(result);
    const content = out && typeof out === 'object' ? out.content : undefined;
    if (typeof content !== 'string' || content.includes(TRUNCATION_MARK)) return;
    remember(out.path || args.path, content);
    if (out.path && out.path !== args.path) remember(args.path, content);
  }

  function recordWrite(path, content) {
    remember(path, content);
  }

  /** Full file after the edit plus the real diff, or null when the file was never seen whole. */
  function applyEdit(args) {
    if (!args || !args.path) return null;
    const oldStr = args.old_string !== undefined ? args.old_string : args.target;
    const newStr = args.new_string !== undefined ? args.new_string : args.replacement;
    if (typeof oldStr !== 'string' || typeof newStr !== 'string' || oldStr === '') return null;
    const before = files.get(String(args.path));
    if (before === undefined || !before.includes(oldStr)) return null;
    const after = args.replace_all ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
    remember(args.path, after);
    const fileName = String(args.path).split('/').pop() || 'file';
    return { content: after, diff: buildUnifiedDiff(before, after, fileName) };
  }

  return { recordRead, recordWrite, applyEdit, has: (p) => files.has(String(p)) };
}

function baseName(filePath) {
  return String(filePath).split('/').pop() || 'file';
}

function extOf(fileName) {
  return fileName.includes('.') ? fileName.split('.').pop() : 'text';
}

/**
 * Maps a finished tool call to the artifact the canvas should open, or null.
 * Keeps the policy out of app.js so it can be tested without a window.
 */
export function artifactForToolResult(model, toolName, callArgs, result) {
  const args = callArgs || {};
  if (toolName === 'read_file') {
    model.recordRead(args, result);
    return null;
  }
  if (isFailedResult(result)) return null;

  if (toolName === 'write_file' && args.path && args.content) {
    const fileName = baseName(args.path);
    model.recordWrite(args.path, args.content);
    return {
      title: fileName,
      filePath: String(args.path),
      language: extOf(fileName),
      content: String(args.content),
      autoPreview: true,
    };
  }

  if (toolName === 'edit_file' && args.path) {
    const filePath = String(args.path);
    const fileName = baseName(filePath);
    const full = model.applyEdit(args);
    if (full) {
      return {
        title: fileName,
        filePath,
        language: extOf(fileName),
        content: full.content,
        diff: full.diff,
        defaultTab: 'code',
      };
    }
    const oldStr = args.old_string !== undefined ? args.old_string : args.target;
    const newStr = args.new_string !== undefined ? args.new_string : args.replacement;
    // Never seen whole: show the snippet and say so. No content here would blank the tab.
    return {
      title: `${fileName} (partial)`,
      filePath,
      language: extOf(fileName),
      content: String(newStr || ''),
      diff: typeof oldStr === 'string' && typeof newStr === 'string'
        ? [
          `--- a/${fileName}`,
          `+++ b/${fileName}`,
          `@@ -1,${oldStr.split('\n').length} +1,${newStr.split('\n').length} @@`,
          ...oldStr.split('\n').map((l) => `-${l}`),
          ...newStr.split('\n').map((l) => `+${l}`),
        ].join('\n')
        : '',
      partial: true,
      defaultTab: 'diff',
    };
  }
  return null;
}

/**
 * Upgrades a "(partial)" edit artifact to the whole file by reading it from the workspace. The edit
 * is already on disk, so the text read is the file AFTER the edit; the "before" side of the diff is
 * rebuilt by undoing the edit, and only when that is unambiguous. Otherwise the code tab still shows
 * the whole file and the diff keeps the honest snippet. Returns null when nothing better is known.
 * `readFile(path)` resolves to `{ok, content}` (the desktop's read-only workspace read).
 */
export async function wholeFileForPartialEdit(model, callArgs, result, readFile) {
  const args = callArgs || {};
  if (!args.path || typeof readFile !== 'function') return null;
  let read;
  try {
    read = await readFile(String(args.path));
  } catch {
    return null;
  }
  if (!read || read.ok !== true || typeof read.content !== 'string') return null;
  const text = read.content;
  const filePath = String(args.path);
  const fileName = baseName(filePath);
  model.recordWrite(filePath, text);

  const oldStr = args.old_string !== undefined ? args.old_string : args.target;
  const newStr = args.new_string !== undefined ? args.new_string : args.replacement;
  const out = unwrapOutput(result);
  const count = out && typeof out.replacementCount === 'number' ? out.replacementCount : 1;
  let diff = '';
  let exact = false;
  if (typeof oldStr === 'string' && typeof newStr === 'string' && newStr !== '' && oldStr !== '') {
    const pieces = text.split(newStr);
    const occurrences = pieces.length - 1;
    const expected = args.replace_all ? count : 1;
    if (occurrences === expected && occurrences > 0) {
      const before = pieces.join(oldStr);
      diff = buildUnifiedDiff(before, text, fileName);
      exact = true;
    }
  }
  if (!exact && typeof oldStr === 'string' && typeof newStr === 'string') {
    diff = [
      `--- a/${fileName}`,
      `+++ b/${fileName}`,
      `@@ -1,${oldStr.split('\n').length} +1,${newStr.split('\n').length} @@`,
      ...oldStr.split('\n').map((l) => `-${l}`),
      ...newStr.split('\n').map((l) => `+${l}`),
    ].join('\n');
  }
  return {
    title: fileName,
    filePath,
    language: extOf(fileName),
    content: text,
    diff,
    defaultTab: 'code',
    diffExact: exact,
  };
}
