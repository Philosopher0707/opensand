import * as fs from 'node:fs';
import * as path from 'node:path';

/** Largest file the canvas may ask for. A bigger file is reported, never truncated into a wrong "full" view. */
export const MAX_WORKSPACE_READ_BYTES = 1024 * 1024;

export type WorkspaceReadResult =
  | { ok: true; path: string; content: string; bytes: number }
  | { ok: false; reason: 'invalid' | 'outside' | 'not_found' | 'not_file' | 'too_large' | 'binary' };

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Read-only: the current text of one file inside `workspaceRoot`. `requested` may be relative to the
 * root or absolute, but its real path (symlinks resolved) must stay inside the real root, so `..`,
 * an absolute path elsewhere and a symlink out of the tree are all refused as `outside`.
 */
export function readWorkspaceFile(
  workspaceRoot: string,
  requested: unknown,
  maxBytes: number = MAX_WORKSPACE_READ_BYTES,
): WorkspaceReadResult {
  if (typeof requested !== 'string' || requested === '' || requested.includes('\0')) {
    return { ok: false, reason: 'invalid' };
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(workspaceRoot);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  const lexical = path.resolve(realRoot, requested);
  // Cheap lexical gate first: `..` and foreign absolute paths never reach the filesystem.
  if (!inside(realRoot, lexical)) return { ok: false, reason: 'outside' };

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(lexical);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  if (!inside(realRoot, realTarget)) return { ok: false, reason: 'outside' };

  let fd: number | undefined;
  try {
    fd = fs.openSync(realTarget, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'not_file' };
    if (st.size > maxBytes) return { ok: false, reason: 'too_large' };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    const data = buf.subarray(0, off);
    if (data.includes(0)) return { ok: false, reason: 'binary' };
    return { ok: true, path: path.relative(realRoot, realTarget).split(path.sep).join('/'), content: data.toString('utf8'), bytes: off };
  } catch {
    return { ok: false, reason: 'not_found' };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
