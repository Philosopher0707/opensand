import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChatMessage } from './types.js';
import { writeEventLogSync, AppendEventInput } from './event-log.js';

/** Bump this whenever a persisted shape under ~/.opensand changes. */
export const CURRENT_SCHEMA_VERSION = 2;

export interface StateMigration {
  /** Version this migration produces. Must be greater than the previous one. */
  to: number;
  up: (stateDir: string) => void;
}

/**
 * Migrates a single session directory to v2 (hash-chained event-log.jsonl).
 */
export function migrateSessionDirToV2(sessionDir: string): boolean {
  const logPath = path.join(sessionDir, 'event-log.jsonl');
  if (fs.existsSync(logPath)) return false;

  const messagesPath = path.join(sessionDir, 'messages.json');
  const metaPath = path.join(sessionDir, 'meta.json');
  const metadataPath = path.join(sessionDir, 'metadata.json');
  const transcriptJsonlPath = path.join(sessionDir, 'transcript.jsonl');

  let meta: Record<string, any> = {};
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      // ignore
    }
  } else if (fs.existsSync(metadataPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch {
      // ignore
    }
  }

  const sessionId = (typeof meta.sessionId === 'string' && meta.sessionId) || path.basename(sessionDir);
  const createdAt = (typeof meta.createdAt === 'string' && meta.createdAt) || new Date().toISOString();

  let messages: ChatMessage[] = [];
  if (fs.existsSync(messagesPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
      if (Array.isArray(parsed)) {
        messages = parsed as ChatMessage[];
      }
    } catch {
      // ignore
    }
  }

  const eventsToAppend: AppendEventInput[] = [];

  eventsToAppend.push({
    kind: 'session.created',
    node: 'plan',
    sessionId,
    ts: createdAt,
    data: {
      sessionId,
      title: meta.title,
      model: meta.model,
      agentId: meta.agentId,
      roomId: meta.roomId,
      createdAt,
    },
  });

  if (messages.length > 0) {
    for (const msg of messages) {
      if (msg.role === 'user') {
        eventsToAppend.push({
          kind: 'turn.started',
          node: 'user',
          sessionId,
          data: msg,
        });
      } else if (msg.role === 'assistant') {
        eventsToAppend.push({
          kind: 'model.completion',
          node: 'act',
          sessionId,
          data: msg,
        });
      } else if (msg.role === 'tool') {
        eventsToAppend.push({
          kind: 'tool.completed',
          node: 'act',
          sessionId,
          data: msg,
        });
      } else if (msg.role === 'system') {
        eventsToAppend.push({
          kind: 'session.system',
          node: 'plan',
          sessionId,
          data: msg,
        });
      }
    }
  } else if (fs.existsSync(transcriptJsonlPath)) {
    try {
      const lines = fs.readFileSync(transcriptJsonlPath, 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry && typeof entry === 'object') {
            const role = entry.role;
            let kind = entry.kind || 'session.event';
            let node = entry.node || 'act';
            if (role === 'user') {
              kind = 'turn.started';
              node = 'user';
            } else if (role === 'assistant') {
              kind = 'model.completion';
              node = 'act';
            } else if (role === 'tool') {
              kind = 'tool.completed';
              node = 'act';
            } else if (role === 'system') {
              kind = 'session.system';
              node = 'plan';
            }
            eventsToAppend.push({
              kind,
              node,
              sessionId,
              ts: entry.timestamp || new Date().toISOString(),
              data: entry,
            });
          }
        } catch {
          // skip invalid json
        }
      }
    } catch {
      // ignore
    }
  }

  if (eventsToAppend.length <= 1 && messages.length === 0 && !fs.existsSync(transcriptJsonlPath)) {
    return false;
  }

  writeEventLogSync(logPath, eventsToAppend);
  return true;
}

export function migrateStateDirToV2(stateDir: string): void {
  const sessionsDir = path.join(stateDir, 'sessions');
  if (fs.existsSync(sessionsDir) && fs.statSync(sessionsDir).isDirectory()) {
    for (const ent of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        migrateSessionDirToV2(path.join(sessionsDir, ent.name));
      }
    }
  }

  if (
    fs.existsSync(path.join(stateDir, 'messages.json')) ||
    fs.existsSync(path.join(stateDir, 'transcript.jsonl')) ||
    fs.existsSync(path.join(stateDir, 'meta.json'))
  ) {
    migrateSessionDirToV2(stateDir);
  }

  for (const ent of fs.readdirSync(stateDir, { withFileTypes: true })) {
    if (ent.isDirectory() && ent.name !== 'sessions' && ent.name !== 'state-backups') {
      const sub = path.join(stateDir, ent.name);
      if (
        fs.existsSync(path.join(sub, 'messages.json')) ||
        fs.existsSync(path.join(sub, 'transcript.jsonl')) ||
        fs.existsSync(path.join(sub, 'meta.json'))
      ) {
        migrateSessionDirToV2(sub);
      }
    }
  }
}

/**
 * Ordered migrations.
 * v1 is the baseline: a missing schema file is treated as 0 and stamped to 1 without touching data.
 * v2 migrates legacy session files (messages.json, meta.json, transcript.jsonl) to hash-chained event-log.jsonl.
 */
export const STATE_MIGRATIONS: StateMigration[] = [
  {
    to: 2,
    up: (stateDir: string) => {
      migrateStateDirToV2(stateDir);
    },
  },
];

export interface MigrationOptions {
  currentVersion?: number;
  migrations?: StateMigration[];
}

export interface MigrationResult {
  from: number;
  to: number;
  migrated: boolean;
  backupDir: string | null;
}

const SCHEMA_FILE = 'schema.json';

export function readSchemaVersion(stateDir: string): number {
  const file = path.join(stateDir, SCHEMA_FILE);
  if (!fs.existsSync(file)) return 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown };
    const version = parsed.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
      throw new Error('version must be a non-negative integer');
    }
    return version;
  } catch (err) {
    throw new Error(
      `Cannot read state schema at ${file}: ${err instanceof Error ? err.message : String(err)}. ` +
        'Restore it from a backup before starting OpenSand.',
    );
  }
}

/**
 * Runs pending migrations in order, after copying the current state aside.
 * Throws instead of downgrading: a newer state file means a newer build wrote it.
 */
export function runStateMigrations(stateDir: string, options: MigrationOptions = {}): MigrationResult {
  const currentVersion = options.currentVersion ?? CURRENT_SCHEMA_VERSION;
  const migrations = (options.migrations ?? STATE_MIGRATIONS).slice().sort((a, b) => a.to - b.to);

  fs.mkdirSync(stateDir, { recursive: true });
  const from = readSchemaVersion(stateDir);

  if (from > currentVersion) {
    throw new Error(
      `State schema v${from} is newer than this build supports (v${currentVersion}). ` +
        'Refusing to start so newer data is not overwritten. Update OpenSand instead.',
    );
  }
  if (from === currentVersion) {
    return { from, to: from, migrated: false, backupDir: null };
  }

  const pending = migrations.filter((m) => m.to > from && m.to <= currentVersion);
  const hasData = fs.readdirSync(stateDir).length > 0;
  const backupDir = from > 0 || hasData ? backupState(stateDir, from) : null;

  for (const migration of pending) {
    migration.up(stateDir);
  }

  writeSchemaVersion(stateDir, currentVersion);
  return { from, to: currentVersion, migrated: true, backupDir };
}

function backupState(stateDir: string, from: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(stateDir, '..', 'state-backups', `v${from}-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
    fs.cpSync(path.join(stateDir, entry.name), path.join(backupDir, entry.name), { recursive: true });
  }
  return backupDir;
}

function writeSchemaVersion(stateDir: string, version: number): void {
  const file = path.join(stateDir, SCHEMA_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
