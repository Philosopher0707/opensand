/**
 * Bounded NDJSON JSON-RPC 2.0 transport over a child process.
 *
 * Shared by the ACP and Codex app-server drivers. One pending map per process,
 * ids are process-wide, every request has a timeout, and every path that ends
 * the transport fails all outstanding requests closed.
 */

import type { ChildProcess } from "node:child_process";

export type RpcId = number;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export interface RpcTransportOptions {
  child: ChildProcess;
  label: string;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (id: RpcId, method: string, params: unknown) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;
const METHOD_NOT_FOUND = -32601;

/** Thrown when the peer closes, errors, or exceeds a request deadline. */
export class RpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "RpcError";
  }
}

export class RpcTransport {
  private readonly child: ChildProcess;
  private readonly label: string;
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly onNotification?: (method: string, params: unknown) => void;
  private readonly onServerRequest?: (id: RpcId, method: string, params: unknown) => void;
  private readonly stdout: NonNullable<ChildProcess["stdout"]>;
  private readonly stdin: NonNullable<ChildProcess["stdin"]>;

  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  private buffer = "";
  private closed = false;

  constructor(options: RpcTransportOptions) {
    const { child, label } = options;
    if (!child.stdout || !child.stdin) {
      throw new Error(`${label}: child process has no stdio pipes`);
    }
    this.child = child;
    this.label = label;
    this.stdout = child.stdout;
    this.stdin = child.stdin;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.onNotification = options.onNotification;
    this.onServerRequest = options.onServerRequest;

    this.stdout.setEncoding("utf8");
    this.stdout.on("data", this.handleData);
    child.on("exit", this.handleExit);
    child.on("error", this.handleError);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Send a request and resolve with its result, or reject on error/timeout/exit. */
  request<T>(method: string, params: unknown = {}, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(`${this.label} transport is closed`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${this.label}: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Send a notification (no id, no response expected). */
  notify(method: string, params: unknown = {}): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Answer a server-initiated request. */
  respond(id: RpcId, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  /** Refuse a server-initiated request. Unknown methods fail closed. */
  reject(id: RpcId, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** Stop accepting messages and fail every outstanding request. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.removeListener("data", this.handleData);
    this.child.removeListener("exit", this.handleExit);
    this.child.removeListener("error", this.handleError);
    this.failAll(new RpcError(`${this.label} transport closed`));
  }

  private write(message: unknown): void {
    if (this.closed) throw new RpcError(`${this.label} transport is closed`);
    this.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private readonly handleData = (chunk: string): void => {
    if (this.closed) return;
    this.buffer += chunk;
    const bytes = Buffer.byteLength(this.buffer, "utf8");
    if (bytes > this.maxLineBytes) {
      this.buffer = "";
      this.failAll(new RpcError(`${this.label}: message exceeded ${this.maxLineBytes} bytes`));
      this.closed = true;
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  };

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const id = message.id;
    const hasResult = "result" in message;
    const hasError = "error" in message;
    const method = message.method;

    if (typeof id === "number" && (hasResult || hasError)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (hasError) {
        const err = message.error as { message?: string; code?: number } | undefined;
        pending.reject(new RpcError(err?.message ?? `${pending.method} failed`, err?.code));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof id === "number" && typeof method === "string") {
      if (this.onServerRequest) {
        this.onServerRequest(id, method, message.params);
      } else {
        this.reject(id, METHOD_NOT_FOUND, `Unsupported request: ${method}`);
      }
      return;
    }

    if (typeof method === "string") {
      this.onNotification?.(method, message.params);
    }
  }

  private readonly handleExit = (): void => {
    this.closed = true;
    this.failAll(new RpcError(`${this.label} process exited`));
  };

  private readonly handleError = (error: Error): void => {
    this.closed = true;
    this.failAll(new RpcError(`${this.label} process error: ${error.message}`));
  };

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
