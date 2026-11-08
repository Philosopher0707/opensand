import { PtySession } from "./pty-session.js";
import {
  PtySessionOptions,
  PtySessionSnapshot,
  PtyReadOutput,
} from "./types.js";

export class PtySessionManager {
  private sessions = new Map<string, PtySession>();

  /**
   * Create and spawn a new PTY / long-running process session.
   */
  async createSession(options: PtySessionOptions): Promise<PtySession> {
    const session = new PtySession(options);
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Retrieve an active or finished session by ID.
   */
  getSession(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  /**
   * Return snapshots for all tracked sessions.
   */
  listSessions(): PtySessionSnapshot[] {
    return Array.from(this.sessions.values()).map((session) => session.getSnapshot());
  }

  /**
   * Terminate a target session by ID.
   */
  async killSession(id: string, signal: NodeJS.Signals | string = "SIGTERM"): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    return await session.kill(signal);
  }

  /**
   * Send live standard input to a target session.
   */
  async writeToSession(id: string, data: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`PTY session not found: ${id}`);
    }
    await session.write(data);
  }

  /**
   * Read buffered output from a session with optional character offset.
   */
  readSession(id: string, offset?: number): PtyReadOutput {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`PTY session not found: ${id}`);
    }
    return session.read(offset);
  }

  /**
   * Terminate and clean up all sessions.
   */
  async closeAll(): Promise<void> {
    const killPromises: Promise<any>[] = [];
    for (const session of this.sessions.values()) {
      if (session.running) {
        killPromises.push(session.kill("SIGTERM").catch(() => false));
      }
    }
    await Promise.all(killPromises);

    const lingering = Array.from(this.sessions.values()).filter((s) => s.running);
    if (lingering.length > 0) {
      await new Promise((r) => setTimeout(r, 100));
      for (const session of lingering) {
        if (session.running) {
          await session.kill("SIGKILL").catch(() => false);
        }
      }
    }

    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}
