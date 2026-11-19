import { spawn, type ChildProcess } from "node:child_process";
import { encodeLine, parseLine, LineDecoder } from "@opensand/protocol";
import type { RequestFrame, SuccessResponseFrame, ErrorResponseFrame } from "@opensand/protocol";
import {
  TARGET_PROTOCOL_VERSION,
  TargetErrorCodes,
  TargetLinkError,
  TargetLostError,
  TargetNotReadyError,
  TargetVersionMismatchError,
  type TargetHelloParams,
  type TargetHelloResult,
  type TargetExecParams,
  type TargetExecResult,
  type TargetReadFileParams, type TargetReadFileResult,
  type TargetWriteFileParams, type TargetWriteFileResult,
  type TargetEditFileParams, type TargetEditFileResult,
  type TargetGrepParams, type TargetGrepResult,
  type TargetGlobParams, type TargetGlobResult,
  type TargetListDirectoryParams, type TargetListDirectoryResult,
  type TargetPingResult,
} from "./types.js";

/**
 * The stdio client for one `opensand-target` child (docs/design/phase8-reach.md §4.2).
 *
 * One child, one line decoder, a request map keyed by id, per-request timeouts
 * and close(). Requests are sent sequentially: a target serializes them so path
 * and command ordering stay deterministic. A request that times out closes the
 * link; a late response is ignored.
 */

export type TargetSpawnFn = () => ChildProcess;

/** Build a spawn fn for a fixed command, e.g. the container's `docker exec -i ...`. */
export function staticTargetSpawn(command: string, args: string[], env?: Record<string, string>, cwd?: string): TargetSpawnFn {
  return () => spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
}

export interface TargetClientOptions {
  spawn: TargetSpawnFn;
  /** This side's package version, checked exactly by target.hello. */
  version: string;
  /** Per-request timeout; a timeout closes the link. Default 120 s. */
  defaultTimeoutMs?: number;
  /** Default timeout for target.exec, which runs arbitrary commands. Default 120 s. */
  execTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class TargetClient {
  private child: ChildProcess | null = null;
  private decoder = new LineDecoder();
  private pending = new Map<string, Pending>();
  private nextId = 0;
  private stderrTail: string[] = [];
  private closed = false;
  private helloCompleted = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TargetClientOptions) {}

  /** Spawn the child and start reading its stdout. Idempotent. */
  start(): void {
    if (this.child) return;
    const child = this.options.spawn();
    if (!child.stdout || !child.stdin) {
      throw new Error("the target child must be spawned with piped stdin and stdout");
    }
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
    });
    child.stdout.on("data", (chunk: string) => {
      for (const line of this.decoder.push(chunk)) {
        this.handleLine(line);
      }
    });
    child.on("error", (err) => this.rejectAll(new TargetLostError(`target process failed: ${err.message}`)));
    child.on("exit", (code, signal) => {
      this.rejectAll(new TargetLostError(`target process exited (code ${code}, signal ${signal})${this.stderrText()}`));
    });
  }

  private stderrText(): string {
    const text = this.stderrTail.join("").trim();
    return text ? `\n${text}` : "";
  }

  private handleLine(line: string): void {
    let frame: SuccessResponseFrame | ErrorResponseFrame;
    try {
      const parsed = parseLine(line);
      if (!("result" in parsed || "error" in parsed)) return; // late or foreign frame: ignored
      frame = parsed as SuccessResponseFrame | ErrorResponseFrame;
    } catch {
      return; // malformed: ignored, diagnostics are the server's stderr
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return; // late response: ignored
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if ("error" in frame) {
      pending.reject(this.linkError(frame.error.code, frame.error.message));
    } else {
      pending.resolve(frame.result);
    }
  }

  private linkError(code: number, message: string): Error {
    if (code === TargetErrorCodes.VersionMismatch) return new TargetVersionMismatchError(message);
    if (code === TargetErrorCodes.NotReady) return new TargetNotReadyError(message);
    return new TargetLinkError(code, message);
  }

  private rejectAll(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  /** Send one request. Requests are serialized: each waits for the previous one. */
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const run = this.queue.then(() => this.send<T>(method, params, timeoutMs));
    this.queue = run.then(() => undefined, () => undefined);
    return run as Promise<T>;
  }

  private send<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new TargetLostError("target link is closed"));
    if (!this.child) return Promise.reject(new TargetLinkError(TargetErrorCodes.Lost, "target child was never started"));
    const id = `t-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // One timed-out request closes the link: the child's state is unknown.
        reject(new TargetLostError(`target request ${method} timed out after ${timeoutMs}ms`));
        void this.close();
      }, timeoutMs ?? this.options.defaultTimeoutMs ?? 120_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      const stdin = this.child!.stdin;
      if (!stdin) throw new Error("the target child has no stdin pipe");
      const frame: RequestFrame = { id, method, params: (params ?? {}) as Record<string, unknown> };
      stdin.write(encodeLine(frame));
    });
  }

  /** Handshake. Must succeed before any other request is accepted. */
  async hello(): Promise<TargetHelloResult> {
    const params: TargetHelloParams = { protocol: TARGET_PROTOCOL_VERSION, clientVersion: this.options.version };
    const result = await this.request<TargetHelloResult>("target.hello", params, 15_000);
    this.helloCompleted = true;
    return result;
  }

  private requireHello(): void {
    if (!this.helloCompleted) {
      throw new TargetNotReadyError("call hello() before using the target");
    }
  }

  exec(params: TargetExecParams): Promise<TargetExecResult> {
    this.requireHello();
    return this.request<TargetExecResult>("target.exec", params, params.timeoutMs ?? this.options.execTimeoutMs);
  }

  readFile(params: TargetReadFileParams): Promise<TargetReadFileResult> {
    this.requireHello();
    return this.request<TargetReadFileResult>("target.readFile", params);
  }

  writeFile(params: TargetWriteFileParams): Promise<TargetWriteFileResult> {
    this.requireHello();
    return this.request<TargetWriteFileResult>("target.writeFile", params);
  }

  editFile(params: TargetEditFileParams): Promise<TargetEditFileResult> {
    this.requireHello();
    return this.request<TargetEditFileResult>("target.editFile", params);
  }

  grep(params: TargetGrepParams): Promise<TargetGrepResult> {
    this.requireHello();
    return this.request<TargetGrepResult>("target.grep", params);
  }

  glob(params: TargetGlobParams): Promise<TargetGlobResult> {
    this.requireHello();
    return this.request<TargetGlobResult>("target.glob", params);
  }

  listDirectory(params: TargetListDirectoryParams): Promise<TargetListDirectoryResult> {
    this.requireHello();
    return this.request<TargetListDirectoryResult>("target.listDirectory", params);
  }

  ping(): Promise<TargetPingResult> {
    this.requireHello();
    return this.request<TargetPingResult>("target.ping", {});
  }

  /** Kill the child. Pending requests are already rejected (by timeout or exit). */
  async close(): Promise<void> {
    const child = this.child;
    this.closed = true;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try { child.kill("SIGTERM"); } catch { clearTimeout(killTimer); resolve(); }
    });
    this.child = null;
  }
}
