/**
 * Canonical path sandbox. Resolves every filesystem path named in a tool call
 * to a real absolute path and refuses anything that escapes workspaceRoot.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export class PathEscapeError extends Error {
  constructor(message: string, public readonly path: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

const PATH_ARG_KEYS = ['path', 'filePath', 'file_path', 'cwd', 'workspaceRoot', 'paths', 'target'];
const COMMAND_KEYS = ['command', 'CommandLine', 'cmd'];
// Leading path tokens only: /abs, ./rel, ../rel, ~/home. URLs are filtered out by the caller.
const COMMAND_PATH_RE = /(?:^|[\s=:])((?:[.~]{0,2}\/|\/)[^\s;|&<>"'`]+)/g;

/** Resolve one path against the workspace root, following symlinks and rejecting escapes. */
export function canonicalizePath(input: unknown, workspaceRoot: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new PathEscapeError('path must be a non-empty string', String(input));
  }
  if (input.includes('\0')) {
    throw new PathEscapeError('null byte in path', input);
  }
  const root = fs.realpathSync(workspaceRoot);
  const normalized = input.replace(/\\/g, '/');
  if (normalized.split('/').includes('..')) {
    throw new PathEscapeError('parent traversal (..) is not allowed', input);
  }
  const absolute = path.isAbsolute(normalized) ? normalized : path.resolve(root, normalized);
  let resolved: string;
  try {
    resolved = fs.realpathSync(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new PathEscapeError(`cannot resolve path: ${(err as Error).message}`, input);
    }
    // A new file's parent is what defines its boundary; the basename is still ours.
    resolved = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  }
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathEscapeError('path escapes workspace root', input);
  }
  return resolved;
}

/** Canonicalize every path named in a tool call's arguments and command line. */
export function canonicalizeArgumentPaths(args: Record<string, unknown>, workspaceRoot: string): string[] {
  const canonical: string[] = [];
  const add = (value: unknown): void => {
    const resolved = canonicalizePath(value, workspaceRoot);
    if (!canonical.includes(resolved)) canonical.push(resolved);
  };

  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) add(item);
    } else if (typeof value === 'string') {
      add(value);
    }
  }

  for (const key of COMMAND_KEYS) {
    const command = args[key];
    if (typeof command !== 'string') continue;
    for (const match of command.matchAll(COMMAND_PATH_RE)) {
      const candidate = match[1].replace(/[),;]+$/, '');
      if (candidate.includes('://') || candidate.startsWith('//')) continue;
      add(candidate);
    }
  }
  return canonical;
}
