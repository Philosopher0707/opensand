import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface EventLogLockInfo {
  pid: number;
  startedAt: number;
  hostname: string;
}

export interface EventLogLockOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleTimeoutMs?: number;
  /** Lock file name inside dir; defaults to event-log.lock. */
  lockFileName?: string;
}

export class EventLogLockTimeoutError extends Error {
  public readonly lockPath: string;

  constructor(lockPath: string, timeoutMs: number) {
    super(`Timeout after ${timeoutMs}ms waiting to acquire event log lock at ${lockPath}`);
    this.name = "EventLogLockTimeoutError";
    this.lockPath = lockPath;
  }
}

const LOCK_FILE_NAME = "event-log.lock";

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

function parseLockInfo(raw: string): Partial<EventLogLockInfo> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function staleLockContent(lockPath: string, staleTimeoutMs: number): Promise<string | null> {
  const raw = await fs.readFile(lockPath, "utf8").catch(() => null);
  if (raw === null) return null;

  const info = parseLockInfo(raw);
  if (typeof info?.pid !== "number" || typeof info.hostname !== "string") {
    const stat = await fs.stat(lockPath).catch(() => null);
    return stat !== null && Date.now() - stat.mtimeMs > staleTimeoutMs ? raw : null;
  }

  if (info.hostname !== os.hostname()) return null;
  return isPidAlive(info.pid) ? null : raw;
}

export class EventLogLock {
  private released = false;

  private constructor(private readonly lockPath: string) {}

  static async acquire(dir: string, options: EventLogLockOptions = {}): Promise<EventLogLock> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollIntervalMs = options.pollIntervalMs ?? 25;
    const staleTimeoutMs = options.staleTimeoutMs ?? 5_000;
    const lockPath = path.join(dir, options.lockFileName ?? LOCK_FILE_NAME);
    const waitStarted = Date.now();

    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    for (;;) {
      try {
        const handle = await fs.open(lockPath, "wx");
        try {
          const info: EventLogLockInfo = { pid: process.pid, startedAt: Date.now(), hostname: os.hostname() };
          await handle.writeFile(JSON.stringify(info), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new EventLogLock(lockPath);
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
      }

      const staleRaw = await staleLockContent(lockPath, staleTimeoutMs);
      if (staleRaw !== null) {
        const current = await fs.readFile(lockPath, "utf8").catch(() => null);
        if (current === staleRaw) await fs.unlink(lockPath).catch(() => {});
        continue;
      }

      if (Date.now() - waitStarted >= timeoutMs) {
        throw new EventLogLockTimeoutError(lockPath, timeoutMs);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const raw = await fs.readFile(this.lockPath, "utf8").catch(() => null);
    if (raw === null) return;
    if (parseLockInfo(raw)?.pid === process.pid) {
      await fs.unlink(this.lockPath).catch(() => {});
    }
  }
}
