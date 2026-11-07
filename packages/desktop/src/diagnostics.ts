import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DesktopSettings } from './types.js';

export interface DiagnosticsInput {
  baseDir: string;
  settings: DesktopSettings;
  stateVersion: number;
  appVersion: string;
  electronVersion?: string;
}

export interface DiagnosticsReport {
  generatedAt: string;
  text: string;
  data: Record<string, unknown>;
}

export function buildDiagnosticsReport(input: DiagnosticsInput): DiagnosticsReport {
  const generatedAt = new Date().toISOString();
  const data: Record<string, unknown> = {
    generatedAt,
    app: input.appVersion,
    electron: input.electronVersion ?? null,
    node: process.version,
    os: `${os.type()} ${os.release()} (${process.arch})`,
    stateDir: input.baseDir,
    stateSchema: input.stateVersion,
    provider: input.settings.provider,
    endpoint: input.settings.endpoint,
    model: input.settings.model,
    apiKey: input.settings.apiKey && input.settings.apiKey !== 'none' ? 'stored' : 'none',
    sessions: countEntries(path.join(input.baseDir, 'sessions')),
    agents: countEntries(path.join(input.baseDir, 'agents')),
    diskFreeMb: diskFreeMb(input.baseDir),
  };

  const text = [
    'OpenSand diagnostics',
    `generated: ${generatedAt}`,
    `app: ${data.app}  electron: ${data.electron ?? 'n/a'}  node: ${data.node}`,
    `os: ${data.os}`,
    `state: ${data.stateDir} (schema v${data.stateSchema})`,
    `model: ${data.provider} · ${data.model} · key ${data.apiKey}`,
    `endpoint: ${data.endpoint}`,
    `sessions: ${data.sessions}  agents: ${data.agents}  disk free: ${data.diskFreeMb} MB`,
  ].join('\n');

  return { generatedAt, text, data };
}

function countEntries(dir: string): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

function diskFreeMb(dir: string): number {
  try {
    const stat = fs.statfsSync(dir);
    return Math.round((stat.bavail * stat.bsize) / (1024 * 1024));
  } catch {
    return 0;
  }
}
