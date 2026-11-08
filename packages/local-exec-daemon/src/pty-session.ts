import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  PtySessionOptions,
  PtySessionSnapshot,
  PtySessionChunk,
  PtyReadOutput,
} from "./types.js";

export class PtySession extends EventEmitter {
  public readonly id: string;
  public readonly options: PtySessionOptions;
  public readonly startedAt: number;
  private stoppedAt: number | null = null;
  private child: ChildProcess;
  private _running: boolean = true;
  private _exitCode: number | null = null;
  private _signal: string | null = null;
  private buffer: string = "";
  private totalChars: number = 0;
  private chunks: PtySessionChunk[] = [];
  public readonly maxBufferSize: number = 128 * 1024; // 128KB rolling buffer limit

  constructor(options: PtySessionOptions, id?: string) {
    super();
    if (!options.command || typeof options.command !== "string" || !options.command.trim()) {
      throw new Error("Command string is required to initialize a PTY session.");
    }

    this.id = id || randomUUID();
    this.options = options;
    this.startedAt = Date.now();

    // Default error listener to avoid unhandled EventEmitter exceptions
    this.on("error", () => {});

    // Sanitize credentials from environment inheritance
    const sanitizedEnv: Record<string, string | undefined> = { ...process.env };
    const SENSITIVE_VARS = new Set([
      "OPENSAND_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENROUTER_API_KEY",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "SLACK_BOT_TOKEN",
      "LINEAR_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "SSH_AUTH_SOCK",
      "OPENSAND_VAULT_PASSPHRASE",
    ]);

    for (const key of Object.keys(sanitizedEnv)) {
      const isSensitive =
        SENSITIVE_VARS.has(key) ||
        (/(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSPHRASE)$/i.test(key) && !key.startsWith("npm_"));
      if (isSensitive && (!options.env || !(key in options.env))) {
        delete sanitizedEnv[key];
      }
    }

    const spawnEnv = {
      ...sanitizedEnv,
      TERM: "xterm-256color",
      COLUMNS: String(options.cols ?? 80),
      LINES: String(options.rows ?? 24),
      ...(options.env ?? {}),
    };

    const cwd = options.cwd ?? process.cwd();

    if (options.args && options.args.length > 0) {
      this.child = spawn(options.command, options.args, {
        cwd,
        env: spawnEnv as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else if (options.command.includes(" ")) {
      this.child = spawn(options.command, {
        cwd,
        env: spawnEnv as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
      });
    } else {
      this.child = spawn(options.command, [], {
        cwd,
        env: spawnEnv as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    this.child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.appendOutput(text, "stdout");
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.appendOutput(text, "stderr");
    });

    this.child.on("error", (err: Error) => {
      if (this._running) {
        this._running = false;
        this.stoppedAt = Date.now();
        this.appendOutput(`\n[Process error: ${err.message}]\n`, "stderr");
        const exitChunk: PtySessionChunk = {
          type: "exit",
          exitCode: 1,
        };
        this.chunks.push(exitChunk);
        this.emit("error", err);
        this.emit("exit", 1, null, exitChunk);
      }
    });

    this.child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this._running) {
        this._running = false;
        this._exitCode = code;
        this._signal = signal ? String(signal) : null;
        this.stoppedAt = Date.now();

        const exitChunk: PtySessionChunk = {
          type: "exit",
          exitCode: code,
        };
        this.chunks.push(exitChunk);

        this.emit("exit", code, this._signal, exitChunk);
      }
    });
  }

  private appendOutput(text: string, type: "stdout" | "stderr"): void {
    this.totalChars += text.length;
    this.buffer += text;
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer = this.buffer.slice(this.buffer.length - this.maxBufferSize);
    }

    const chunkObj: PtySessionChunk = { type, text };
    if (this.chunks.length >= 1000) {
      this.chunks.shift();
    }
    this.chunks.push(chunkObj);

    this.emit("data", text, chunkObj);
    this.emit("chunk", chunkObj);
  }

  get pid(): number {
    return this.child?.pid ?? -1;
  }

  get running(): boolean {
    return this._running;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get signal(): string | null {
    return this._signal;
  }

  get durationMs(): number {
    return this.stoppedAt !== null
      ? this.stoppedAt - this.startedAt
      : Date.now() - this.startedAt;
  }

  getSnapshot(): PtySessionSnapshot {
    return {
      id: this.id,
      pid: this.pid,
      running: this._running,
      exitCode: this._exitCode,
      signal: this._signal,
      durationMs: this.durationMs,
    };
  }

  getOutput(): string {
    return this.buffer;
  }

  getChunks(): PtySessionChunk[] {
    return [...this.chunks];
  }

  async write(data: string): Promise<void> {
    if (!this._running || !this.child?.stdin || !this.child.stdin.writable) {
      throw new Error(`Cannot write to stopped PTY session: ${this.id}`);
    }

    return new Promise<void>((resolve, reject) => {
      this.child.stdin!.write(data, "utf-8", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async kill(signal: NodeJS.Signals | string = "SIGTERM"): Promise<boolean> {
    if (!this._running || !this.child) {
      return false;
    }
    try {
      return this.child.kill(signal as NodeJS.Signals);
    } catch {
      return false;
    }
  }

  read(offset?: number): PtyReadOutput {
    let output = "";
    const nextOffset = this.totalChars;

    if (offset === undefined || offset === null) {
      output = this.buffer;
    } else {
      const startIdx = this.totalChars - this.buffer.length;
      if (offset <= startIdx) {
        output = this.buffer;
      } else if (offset < this.totalChars) {
        output = this.buffer.slice(offset - startIdx);
      } else {
        output = "";
      }
    }

    return {
      id: this.id,
      output,
      offset: nextOffset,
      nextOffset,
      running: this._running,
      exitCode: this._exitCode,
      signal: this._signal,
    };
  }

  waitForExit(timeoutMs: number = 5000): Promise<PtySessionSnapshot> {
    if (!this._running) {
      return Promise.resolve(this.getSnapshot());
    }

    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const onExit = () => {
        if (timer) clearTimeout(timer);
        resolve(this.getSnapshot());
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.off("exit", onExit);
          resolve(this.getSnapshot());
        }, timeoutMs);
        timer.unref();
      }

      this.once("exit", onExit);
    });
  }
}
