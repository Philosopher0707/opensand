import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FolderTrustStore } from "@opensand/shared";

export const binPath = new URL("../src/bin.js", import.meta.url).pathname;

export interface WireFrame {
  id?: string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
  event?: string;
  seq?: number;
  ts?: string;
  data?: any;
}

export function tempDir(prefix: string): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), `opensand-engine-${prefix}-`));
  fsSync.mkdirSync(path.join(dir, "home"), { recursive: true });
  return dir;
}

export function removeDir(dir: string): void {
  fsSync.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

export class EngineProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly frames: WireFrame[] = [];
  readonly rawLines: string[] = [];
  readonly invalidLines: string[] = [];
  stderr = "";
  private buffered = "";
  private readonly waiters: Array<{ predicate: (frame: WireFrame) => boolean; resolve: (frame: WireFrame) => void }> = [];
  readonly exited: Promise<number | null>;

  constructor(readonly stateDir: string, extraArgs: string[] = []) {
    this.child = spawn(process.execPath, [binPath, "--stdio", "--state-dir", stateDir, ...extraArgs], {
      env: { ...process.env, HOME: path.join(stateDir, "home") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.exited = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
  }

  private onStdout(chunk: string): void {
    this.buffered += chunk;
    const lines = this.buffered.split("\n");
    this.buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) continue;
      this.rawLines.push(line);
      let frame: WireFrame;
      try {
        frame = JSON.parse(line) as WireFrame;
      } catch {
        this.invalidLines.push(line);
        continue;
      }
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(frame)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    }
  }

  send(frame: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  waitFor(predicate: (frame: WireFrame) => boolean, timeoutMs = 5_000): Promise<WireFrame> {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for frame; got ${JSON.stringify(this.frames)}`));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  request(id: string, method: string, params: Record<string, unknown> = {}): Promise<WireFrame> {
    this.send({ id, method, params });
    return this.waitFor((frame) => frame.id === id);
  }

  async kill(signal: NodeJS.Signals = "SIGKILL"): Promise<number | null> {
    this.child.kill(signal);
    return this.exited;
  }
}

/** Mark `folder` trusted in the engine's state dir, so a mission there is not held on the trust question. */
export function trustFolder(stateDir: string, folder: string): void {
  const key = FolderTrustStore.canonicalFolder(folder);
  fsSync.writeFileSync(
    path.join(stateDir, "folder-trust.json"),
    JSON.stringify({ version: 1, folders: { [key]: { level: "trusted", updatedAt: Date.now(), updatedBy: "test" } } }),
  );
}
