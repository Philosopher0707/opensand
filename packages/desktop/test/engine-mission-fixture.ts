import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FolderTrustStore } from '@opensand/shared';

const pkgRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const engineBin = path.resolve(pkgRoot, '..', 'engine', 'dist', 'src', 'bin.js');

export function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env as NodeJS.ProcessEnv;
}

export function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

export function makeGitWorkspace(files: Record<string, string>): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-restore-ws-')));
  git(['init', '-q'], ws);
  git(['config', 'user.email', 'test@example.com'], ws);
  git(['config', 'user.name', 'OpenSand Test'], ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, 'utf8');
  }
  git(['add', '-A'], ws);
  git(['commit', '-q', '--no-gpg-sign', '-m', 'initial'], ws);
  return ws;
}

export function trustFolderIn(stateDir: string, folder: string): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const key = FolderTrustStore.canonicalFolder(folder);
  fs.writeFileSync(
    path.join(stateDir, 'folder-trust.json'),
    JSON.stringify({ version: 1, folders: { [key]: { level: 'trusted', updatedAt: Date.now(), updatedBy: 'test' } } }),
  );
}

export interface FinishedMission {
  missionId: string;
  /** Snapshot ref pinned before each step, in order (s-1, s-2, ...). */
  snapshots: string[];
}

/**
 * Runs a REAL mission through the real `opensand-engine --stdio` process with a scripted agent, so
 * the logs, snapshot refs and file changes are the engine's own. Resolves when the mission ends.
 */
export async function runScriptedMission(stateDir: string, workspace: string, spec: unknown): Promise<FinishedMission> {
  fs.mkdirSync(stateDir, { recursive: true });
  const agentFile = path.join(stateDir, 'scripted-agent.json');
  fs.writeFileSync(agentFile, JSON.stringify(spec), 'utf8');
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [engineBin, '--stdio', '--state-dir', stateDir, '--scripted-agent', agentFile], {
    env: { ...cleanGitEnv(), HOME: path.join(stateDir, '..') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const waiters = new Map<string, (f: any) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c: string) => {
    buf += c;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) {
      if (!l) continue;
      try {
        const f = JSON.parse(l);
        if (f.id && waiters.has(f.id)) { waiters.get(f.id)!(f); waiters.delete(f.id); }
      } catch { /* not a frame */ }
    }
  });
  const request = (id: string, method: string, params: Record<string, unknown>) =>
    new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`engine request ${method} timed out`)), 20_000);
      waiters.set(id, (f) => { clearTimeout(t); resolve(f); });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  try {
    const start = await request('start', 'mission.Missions.start', {
      workspaceRoot: workspace, title: 'scripted mission', initialQuery: 'go', checkCommand: 'true',
    });
    if (start.error) throw new Error(`mission start failed: ${JSON.stringify(start.error)}`);
    const missionId: string = start.result.missionId;
    const deadline = Date.now() + 30_000;
    for (let i = 0; Date.now() < deadline; i++) {
      const g = await request(`get-${i}`, 'mission.Missions.get', { missionId });
      if (g.result && ['verified', 'failed', 'stopped'].includes(g.result.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const dir = path.join(stateDir, 'missions', missionId);
    const log = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
      .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    const snapshots = log.filter((e) => e.kind === 'node.started' && e.data?.snapshot).map((e) => e.data.snapshot as string);
    return { missionId, snapshots };
  } finally {
    child.kill('SIGKILL');
  }
}
