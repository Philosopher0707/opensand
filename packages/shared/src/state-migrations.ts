import * as fs from "node:fs";
import * as path from "node:path";
import { EVENT, GENESIS_PREV_HASH, type SessionEvent } from "./event-log-types.js";
import { canonicalJson, computeLineHash } from "./event-log.js";

/** Bump this whenever a persisted shape under ~/.opensand changes. */
export const CURRENT_SCHEMA_VERSION = 2;

export interface StateMigration {
  /** Version this migration produces. Must be greater than the previous one. */
  to: number;
  up: (stateDir: string) => void;
}

export interface SessionMigrationReport {
  sessionId: string;
  sessionDir: string;
  status: "migrated" | "skipped_existing" | "skipped_broken";
  reason?: string;
}

export interface MigrationV2Report {
  sessions: SessionMigrationReport[];
}

let latestV2Report: MigrationV2Report | undefined;

export function getLastMigrationReport(): MigrationV2Report | undefined {
  return latestV2Report;
}

export function findSessionDirectories(stateDir: string): string[] {
  const dirs: string[] = [];
  const visited = new Set<string>();

  const checkParent = (parentDir: string) => {
    if (!fs.existsSync(parentDir)) return;
    try {
      const realParent = fs.realpathSync(parentDir);
      if (visited.has(realParent)) return;
      visited.add(realParent);

      const entries = fs.readdirSync(parentDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory()) {
          dirs.push(path.join(parentDir, ent.name));
        }
      }
    } catch {
      // ignore
    }
  };

  // 1. Check stateDir/sessions
  checkParent(path.join(stateDir, "sessions"));
  // 2. Check stateDir/../sessions
  checkParent(path.join(stateDir, "..", "sessions"));
  // 3. Check if stateDir itself contains session subdirectories
  if (dirs.length === 0 && fs.existsSync(stateDir)) {
    try {
      const entries = fs.readdirSync(stateDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && ent.name !== "state-backups" && ent.name !== "state") {
          const sub = path.join(stateDir, ent.name);
          if (
            fs.existsSync(path.join(sub, "meta.json")) ||
            fs.existsSync(path.join(sub, "metadata.json")) ||
            fs.existsSync(path.join(sub, "messages.json")) ||
            fs.existsSync(path.join(sub, "transcript.jsonl")) ||
            fs.existsSync(path.join(sub, "event-log.jsonl"))
          ) {
            dirs.push(sub);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return dirs;
}

export function migrateSessionFolder(sessionDir: string): SessionMigrationReport {
  const sessionId = path.basename(sessionDir);
  const eventLogPath = path.join(sessionDir, "event-log.jsonl");

  // Guard: If event-log.jsonl already exists, skip (idempotent).
  // Guard: If event-log.jsonl already exists, skip (idempotent).
  if (fs.existsSync(eventLogPath)) {
    return { sessionId, sessionDir, status: "skipped_existing" };
  }

  // Clean up any stale temp files from a previous crashed migration
  try {
    const entries = fs.readdirSync(sessionDir);
    for (const ent of entries) {
      if (ent.startsWith("event-log.jsonl.") && ent.endsWith(".tmp")) {
        try { fs.rmSync(path.join(sessionDir, ent), { force: true }); } catch {}
      }
    }
  } catch {}

  const metaPath = path.join(sessionDir, "meta.json");
  const metadataPath = path.join(sessionDir, "metadata.json");
  let metaObj: Record<string, unknown> | null = null;

  if (fs.existsSync(metaPath)) {
    try {
      metaObj = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      return { sessionId, sessionDir, status: "skipped_broken", reason: "Unparseable meta.json" };
    }
  } else if (fs.existsSync(metadataPath)) {
    try {
      metaObj = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    } catch {
      return { sessionId, sessionDir, status: "skipped_broken", reason: "Unparseable metadata.json" };
    }
  } else {
    return { sessionId, sessionDir, status: "skipped_broken", reason: "Missing meta.json" };
  }

  const messagesPath = path.join(sessionDir, "messages.json");
  const transcriptPath = path.join(sessionDir, "transcript.jsonl");
  let messages: unknown[] | null = null;

  if (fs.existsSync(messagesPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(messagesPath, "utf8"));
      if (Array.isArray(parsed)) {
        messages = parsed;
      } else {
        return { sessionId, sessionDir, status: "skipped_broken", reason: "messages.json is not an array" };
      }
    } catch {
      return { sessionId, sessionDir, status: "skipped_broken", reason: "Unparseable messages.json" };
    }
  } else if (fs.existsSync(transcriptPath)) {
    try {
      const lines = fs.readFileSync(transcriptPath, "utf8").trim().split("\n").filter(Boolean);
      const parsedLines: unknown[] = [];
      for (const line of lines) {
        parsedLines.push(JSON.parse(line));
      }
      messages = parsedLines;
    } catch {
      return { sessionId, sessionDir, status: "skipped_broken", reason: "Unparseable transcript.jsonl" };
    }
  } else {
    return { sessionId, sessionDir, status: "skipped_broken", reason: "Missing messages.json or transcript.jsonl" };
  }

  const model = typeof metaObj?.model === "string" ? metaObj.model : "";
  const createdAt =
    typeof metaObj?.createdAt === "string" && metaObj.createdAt
      ? metaObj.createdAt
      : new Date().toISOString();
  const updatedAt =
    typeof metaObj?.updatedAt === "string" && metaObj.updatedAt
      ? metaObj.updatedAt
      : createdAt;
  const actualSessionId =
    typeof metaObj?.sessionId === "string" && metaObj.sessionId
      ? metaObj.sessionId
      : sessionId;

  const ev1: SessionEvent = {
    seq: 1,
    ts: createdAt,
    sessionId: actualSessionId,
    attempt: 1,
    node: "act",
    kind: EVENT.sessionCreated,
    data: { model },
    prev: GENESIS_PREV_HASH,
  };
  const line1 = canonicalJson(ev1);
  const hash1 = computeLineHash(line1);

  const ev2: SessionEvent = {
    seq: 2,
    ts: updatedAt,
    sessionId: actualSessionId,
    attempt: 1,
    node: "act",
    kind: EVENT.snapshot,
    data: { messages },
    prev: hash1,
  };
  const line2 = canonicalJson(ev2);
  const payload = `${line1}\n${line2}\n`;

  // Write crash-safely: write to tmp, fsync fd, rename, fsync dir
  const tmpPath = path.join(sessionDir, `event-log.jsonl.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmpPath, "w", 0o600);
  try {
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, eventLogPath);

  try {
    const dirFd = fs.openSync(sessionDir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // ignore directory fsync errors on unsupported platforms
  }

  return { sessionId, sessionDir, status: "migrated" };
}

export function migrateV2(stateDir: string): MigrationV2Report {
  const report: MigrationV2Report = { sessions: [] };
  const sessionDirs = findSessionDirectories(stateDir);

  for (const dir of sessionDirs) {
    try {
      if (fs.statSync(dir).isDirectory()) {
        const itemReport = migrateSessionFolder(dir);
        report.sessions.push(itemReport);
      }
    } catch (err) {
      report.sessions.push({
        sessionId: path.basename(dir),
        sessionDir: dir,
        status: "skipped_broken",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  latestV2Report = report;
  return report;
}

/**
 * Ordered migrations.
 * v1 is the baseline: a missing schema file is treated as 0 and stamped to 1.
 * v2 migrates legacy sessions to event-log.jsonl.
 */
export const STATE_MIGRATIONS: StateMigration[] = [
  {
    to: 2,
    up: (stateDir: string) => {
      migrateV2(stateDir);
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
  report?: MigrationV2Report;
}

const SCHEMA_FILE = "schema.json";

export function readSchemaVersion(stateDir: string): number {
  const file = path.join(stateDir, SCHEMA_FILE);
  if (!fs.existsSync(file)) return 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
    const version = parsed.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
      throw new Error("version must be a non-negative integer");
    }
    return version;
  } catch (err) {
    throw new Error(
      `Cannot read state schema at ${file}: ${err instanceof Error ? err.message : String(err)}. ` +
        "Restore it from a backup before starting OpenSand.",
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
        "Refusing to start so newer data is not overwritten. Update OpenSand instead.",
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
  return { from, to: currentVersion, migrated: true, backupDir, report: latestV2Report };
}

function backupState(stateDir: string, from: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(stateDir, "..", "state-backups", `v${from}-${stamp}`);
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
