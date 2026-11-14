import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { EventLogReader } from '@opensand/shared';
import { changedEntries, displayPath } from './mission-receipt-model.js';
import { parseUnifiedDiff, DIFF_MAX_BYTES, type FileDiffView } from './mission-diff-model.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TREE_ID = /^[0-9a-f]{40,64}$/;
const TERMINAL = new Set(['mission.verified', 'mission.failed', 'mission.stopped']);
const GIT_TIMEOUT_MS = 10_000;

function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; overflow: boolean }> {
  // Hooks and the user's shell may export these; the diff must come from the workspace's own repository.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER']) delete env[k];
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env, encoding: 'utf8', maxBuffer: DIFF_MAX_BYTES, timeout: GIT_TIMEOUT_MS }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout, overflow: false });
      const e = err as NodeJS.ErrnoException & { code?: string | number };
      const overflow = e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout: overflow ? '' : String(stdout ?? ''), overflow });
    });
  });
}

/**
 * Read-only diff of one changed file of an ended mission. The file is looked up by index in the
 * receipt's own changed list, never taken from the renderer, and only that file's hunks are
 * returned. `git diff` runs without a shell, external diff drivers or textconv, in the workspace
 * recorded on `mission.started`.
 */
export async function readMissionFileDiff(baseDir: string, missionId: unknown, fileIndex: unknown): Promise<FileDiffView | null> {
  if (typeof missionId !== 'string' || !SAFE_ID.test(missionId)) throw new Error('Invalid mission id');
  if (typeof fileIndex !== 'number' || !Number.isInteger(fileIndex) || fileIndex < 0) throw new Error('Invalid file index');
  const dir = path.join(baseDir, 'missions', missionId);
  if (!fs.existsSync(dir)) return null;
  const { events } = await new EventLogReader(dir).readWithRecovery();
  const sorted = [...(events as any[])].sort((a, b) => a.seq - b.seq);
  const started = sorted.find((e) => e.kind === 'mission.started');
  const terminal = [...sorted].reverse().find((e) => TERMINAL.has(e.kind));
  const entry = changedEntries(terminal?.data?.receipt)[fileIndex];
  if (!terminal || !entry) return null;

  const file = displayPath(entry.file);
  const unavailable: FileDiffView = { state: 'unavailable', file };
  const { baseTree, finalTree } = terminal.data ?? {};
  const root = started?.data?.workspaceRoot;
  const rel = entry.file.replace(/\\/g, '/');
  if (typeof baseTree !== 'string' || typeof finalTree !== 'string' || !TREE_ID.test(baseTree) || !TREE_ID.test(finalTree)) return unavailable;
  if (typeof root !== 'string' || !path.isAbsolute(root) || !fs.existsSync(root)) return unavailable;
  if (path.isAbsolute(rel) || rel.split('/').includes('..') || rel.startsWith('-')) return unavailable;

  const res = await runGit(root, ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', baseTree, finalTree, '--', rel]);
  if (res.overflow) return { state: 'too-large', file };
  if (res.code !== 0) return unavailable;
  const parsed = parseUnifiedDiff(res.stdout);
  if (parsed.tooManyLines) return { state: 'too-large', file };
  if (parsed.binary) return { state: 'binary', file };
  return { state: 'ready', file, hunks: parsed.hunks };
}
