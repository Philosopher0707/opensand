import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SessionLockInfo } from "./types.js";

export class SessionLockedError extends Error {
  public readonly sessionId: string;
  public readonly pid?: number;

  constructor(sessionId: string, pid?: number) {
    super(`Session '${sessionId}' is locked by active process (PID ${pid ?? "unknown"}).`);
    this.name = "SessionLockedError";
    this.sessionId = sessionId;
    this.pid = pid;
  }
}

export interface SessionLockHandle {
  sessionId: string;
  pid: number;
  lockPath: string;
  release(): Promise<void>;
}

export interface SessionLockInspection {
  locked: boolean;
  pid?: number;
  stale: boolean;
}

export function isPidAlive(pid: number): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err.code === "ESRCH") {
      return false;
    }
    if (err.code === "EPERM") {
      // Process exists but signal permission denied
      return true;
    }
    return false;
  }
}

export class SessionLockManager {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), ".opensand", "sessions");
  }

  getLockPath(sessionId: string): string {
    return path.join(this.baseDir, sessionId, "session.lock");
  }

  async inspect(sessionId: string): Promise<SessionLockInspection> {
    const lockPath = this.getLockPath(sessionId);
    try {
      const raw = await fs.readFile(lockPath, "utf-8");
      let info: SessionLockInfo;
      try {
        info = JSON.parse(raw) as SessionLockInfo;
      } catch {
        // Corrupted lock file: lock file exists on disk, but stale
        return { locked: true, pid: undefined, stale: true };
      }

      if (typeof info?.pid !== "number") {
        return { locked: true, pid: undefined, stale: true };
      }

      const alive = isPidAlive(info.pid);
      return {
        locked: true,
        pid: info.pid,
        stale: !alive,
      };
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return { locked: false, pid: undefined, stale: false };
      }
      return { locked: false, pid: undefined, stale: false };
    }
  }

  async acquire(sessionId: string, options?: { force?: boolean }): Promise<SessionLockHandle> {
    const lockPath = this.getLockPath(sessionId);
    const sessionDir = path.dirname(lockPath);
    await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });

    const status = await this.inspect(sessionId);
    if (status.locked) {
      if (status.stale || options?.force) {
        await fs.rm(lockPath, { force: true });
      } else {
        throw new SessionLockedError(sessionId, status.pid);
      }
    }

    const lockInfo: SessionLockInfo = {
      pid: process.pid,
      startedAt: Date.now(),
      hostname: os.hostname(),
    };

    try {
      await fs.writeFile(lockPath, JSON.stringify(lockInfo, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (err: any) {
      if (err.code === "EEXIST") {
        // Concurrent write collision — recheck lock liveness
        const recheck = await this.inspect(sessionId);
        if (recheck.locked && !recheck.stale && !options?.force) {
          throw new SessionLockedError(sessionId, recheck.pid);
        }
        await fs.writeFile(lockPath, JSON.stringify(lockInfo, null, 2), {
          encoding: "utf-8",
          mode: 0o600,
        });
      } else {
        throw err;
      }
    }

    let released = false;
    const handle: SessionLockHandle = {
      sessionId,
      pid: process.pid,
      lockPath,
      release: async () => {
        if (released) return;
        released = true;
        try {
          const current = await this.inspect(sessionId);
          // Only release if the lock still belongs to this process
          if (current.locked && current.pid === process.pid) {
            await fs.rm(lockPath, { force: true });
          }
        } catch {
          await fs.rm(lockPath, { force: true }).catch(() => {});
        }
      },
    };

    return handle;
  }
}
