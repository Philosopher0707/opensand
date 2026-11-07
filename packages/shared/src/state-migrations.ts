import * as fs from 'node:fs';
import * as path from 'node:path';

/** Bump this whenever a persisted shape under ~/.opensand changes. */
export const CURRENT_SCHEMA_VERSION = 1;

export interface StateMigration {
  /** Version this migration produces. Must be greater than the previous one. */
  to: number;
  up: (stateDir: string) => void;
}

/**
 * Ordered migrations. v1 is the baseline: a missing schema file is treated as 0
 * and stamped to 1 without touching data.
 */
export const STATE_MIGRATIONS: StateMigration[] = [];

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
