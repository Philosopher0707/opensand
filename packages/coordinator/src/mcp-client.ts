import { ChildProcess, spawn } from "node:child_process";
import * as readline from "node:readline";
import { Readable, Writable } from "node:stream";

export type McpTransport = "stdio" | "sse";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  transport?: McpTransport;
  headers?: Record<string, string>;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolCallResult {
  content: McpToolContent[];
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface McpClientOptions {
  serverName: string;
  config?: McpServerConfig;
  customStreams?: {
    stdin: Writable;
    stdout: Readable;
  };
  requestTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class McpClient {
  public readonly serverName: string;
  private config?: McpServerConfig;
  private customStreams?: { stdin: Writable; stdout: Readable };
  private process: ChildProcess | null = null;
  private stdin: Writable | null = null;
  private stdout: Readable | null = null;
  private rl: readline.Interface | null = null;
  private abortController: AbortController | null = null;
  private sseMessageUrl: string | null = null;
  private fetchFn: typeof fetch;
  private resolveEndpoint: ((url: string) => void) | null = null;

  private nextRequestId = 1;
  private pendingRequests = new Map<
    number,
    {
      resolve: (res: any) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private requestTimeoutMs: number;
  private isInitialized = false;

  constructor(options: McpClientOptions) {
    this.serverName = options.serverName;
    this.config = options.config;
    this.customStreams = options.customStreams;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis);
  }

  get transport(): McpTransport {
    if (this.config?.transport) {
      return this.config.transport;
    }
    if (this.config?.url && !this.config?.command) {
      return "sse";
    }
    return "stdio";
  }

  get running(): boolean {
    return this.process !== null || this.customStreams !== undefined || this.abortController !== null;
  }

  get initialized(): boolean {
    return this.isInitialized;
  }

  get messageUrl(): string | null {
    return this.sseMessageUrl;
  }

  /**
   * Start the MCP client connection (stdio child process or SSE event stream).
   */
  async start(): Promise<void> {
    if (this.customStreams) {
      this.stdin = this.customStreams.stdin;
      this.stdout = this.customStreams.stdout;

      this.rl = readline.createInterface({
        input: this.stdout,
        crlfDelay: Infinity,
      });

      this.rl.on("line", (line) => {
        this.handleIncomingLine(line);
      });
      return;
    }

    if (this.transport === "sse") {
      if (!this.config?.url) {
        throw new Error(`MCP client [${this.serverName}] SSE transport requires url in configuration`);
      }

      this.abortController = new AbortController();
      const endpointPromise = new Promise<string>((resolve) => {
        this.resolveEndpoint = resolve;
      });

      const response = await this.fetchFn(this.config.url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          ...(this.config.headers ?? {}),
        },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(
          `MCP client [${this.serverName}] SSE connection failed (${response.status}): ${response.statusText}`
        );
      }

      if (!response.body) {
        throw new Error(`MCP client [${this.serverName}] SSE response body is null`);
      }

      // Start consuming the streaming events in the background
      this.consumeSseStream(response.body);

      // Wait for the endpoint event or fallback to base url
      const fallbackTimer = new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve(this.config!.url!);
        }, 1500);
      });

      this.sseMessageUrl = await Promise.race([endpointPromise, fallbackTimer]);
      return;
    }

    // stdio transport
    if (!this.config?.command) {
      throw new Error(`MCP client [${this.serverName}] requires command or url in configuration`);
    }

    const env = { ...process.env, ...(this.config.env ?? {}) };
    this.process = spawn(this.config.command, this.config.args ?? [], {
      env,
      cwd: this.config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.stdin = this.process.stdin;
    this.stdout = this.process.stdout;

    this.process.on("error", (err) => {
      this.rejectAllPending(new Error(`MCP server [${this.serverName}] process error: ${err.message}`));
    });

    this.process.on("exit", (code, signal) => {
      this.rejectAllPending(
        new Error(`MCP server [${this.serverName}] exited unexpectedly (code: ${code}, signal: ${signal})`)
      );
      this.process = null;
    });

    if (!this.stdin || !this.stdout) {
      throw new Error(`Failed to bind stdio pipes for MCP server [${this.serverName}]`);
    }

    this.rl = readline.createInterface({
      input: this.stdout,
      crlfDelay: Infinity,
    });

    this.rl.on("line", (line) => {
      this.handleIncomingLine(line);
    });
  }

  /**
   * Perform the MCP protocol initialization handshake.
   */
  async initialize(): Promise<{ serverInfo: { name: string; version?: string } }> {
    const initResponse = await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "OpenSand",
        version: "0.1.0",
      },
    });

    await this.sendNotification("notifications/initialized");
    this.isInitialized = true;
    return initResponse;
  }

  /**
   * List all tools offered by this MCP server.
   */
  async listTools(): Promise<McpToolDefinition[]> {
    const res = await this.sendRequest("tools/list", {});
    const tools = res?.tools;
    if (!Array.isArray(tools)) {
      return [];
    }

    return tools.map((t: any) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    }));
  }

  /**
   * Call a tool on this MCP server.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const res = await this.sendRequest("tools/call", {
      name,
      arguments: args,
    });

    return {
      content: res?.content || [],
      isError: res?.isError ?? false,
    };
  }

  /**
   * Consume an SSE response stream and process events.
   */
  private async consumeSseStream(body: any): Promise<void> {
    try {
      let currentEvent = "message";
      let currentData: string[] = [];

      const flushBlock = () => {
        if (currentData.length > 0) {
          const raw = currentData.join("\n");
          if (currentEvent === "endpoint") {
            const rawUrl = raw.trim();
            const resolved =
              rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
                ? rawUrl
                : new URL(rawUrl, this.config?.url).toString();
            this.sseMessageUrl = resolved;
            if (this.resolveEndpoint) {
              this.resolveEndpoint(resolved);
              this.resolveEndpoint = null;
            }
          } else {
            this.handleIncomingLine(raw);
          }
          currentData = [];
          currentEvent = "message";
        }
      };

      if (Symbol.asyncIterator in body) {
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        for await (const chunk of body) {
          buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              flushBlock();
              continue;
            }
            if (trimmed.startsWith(":")) {
              continue;
            }
            if (trimmed.startsWith("event:")) {
              currentEvent = trimmed.slice(6).trim();
            } else if (trimmed.startsWith("data:")) {
              currentData.push(trimmed.slice(5).trim());
            }
          }
        }

        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith("data:")) {
            currentData.push(trimmed.slice(5).trim());
          }
          flushBlock();
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError" || this.abortController?.signal.aborted) {
        return;
      }
      this.rejectAllPending(new Error(`MCP server [${this.serverName}] SSE stream error: ${err?.message ?? err}`));
    }
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<any> {
    if (!this.running) {
      throw new Error(`MCP server [${this.serverName}] is not running`);
    }

    const id = this.nextRequestId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    if (this.transport === "sse") {
      const targetUrl = this.sseMessageUrl || this.config?.url;
      if (!targetUrl) {
        throw new Error(`MCP server [${this.serverName}] has no message endpoint configured`);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request [${method}] timed out after ${this.requestTimeoutMs}ms`));
        }, this.requestTimeoutMs);

        this.pendingRequests.set(id, { resolve, reject, timer });

        this.fetchFn(targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.config?.headers ?? {}),
          },
          body: JSON.stringify(payload),
          signal: this.abortController?.signal,
        })
          .then(async (res) => {
            if (!res.ok) {
              clearTimeout(timer);
              this.pendingRequests.delete(id);
              reject(new Error(`MCP HTTP request failed (${res.status}): ${res.statusText}`));
              return;
            }
            const ct = res.headers?.get?.("content-type") || "";
            if (ct.includes("application/json")) {
              const text = await res.text();
              this.handleIncomingLine(text);
            }
          })
          .catch((err) => {
            clearTimeout(timer);
            this.pendingRequests.delete(id);
            reject(err);
          });
      });
    }

    // stdio transport
    if (!this.stdin) {
      throw new Error(`MCP server [${this.serverName}] is not running`);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request [${method}] timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const line = JSON.stringify(payload) + "\n";
      this.stdin?.write(line, "utf-8", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  private async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.running) {
      throw new Error(`MCP server [${this.serverName}] is not running`);
    }

    const payload: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    if (this.transport === "sse") {
      const targetUrl = this.sseMessageUrl || this.config?.url;
      if (!targetUrl) return;

      await this.fetchFn(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config?.headers ?? {}),
        },
        body: JSON.stringify(payload),
        signal: this.abortController?.signal,
      }).catch(() => {});
      return;
    }

    if (!this.stdin) {
      throw new Error(`MCP server [${this.serverName}] is not running`);
    }

    const line = JSON.stringify(payload) + "\n";
    return new Promise((resolve, reject) => {
      this.stdin?.write(line, "utf-8", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Process a single incoming line from stdout or SSE event data.
   */
  private handleIncomingLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Ignore non-JSON output (e.g. server debug logging)
      return;
    }

    if (typeof parsed.id === "number") {
      const pending = this.pendingRequests.get(parsed.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(parsed.id);

        if (parsed.error) {
          pending.reject(
            new Error(`MCP error [${parsed.error.code}]: ${parsed.error.message}`)
          );
        } else {
          pending.resolve(parsed.result);
        }
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  /**
   * Gracefully terminate the MCP client, child process, or SSE connection.
   */
  async close(): Promise<void> {
    this.rejectAllPending(new Error(`MCP client [${this.serverName}] closed`));

    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {
        // Ignore
      }
      this.abortController = null;
    }

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    if (this.process) {
      const proc = this.process;
      this.process = null;
      try {
        proc.stdin?.end();
        proc.kill("SIGTERM");
      } catch {
        // Ignore
      }
    }

    this.stdin = null;
    this.stdout = null;
    this.isInitialized = false;
    this.sseMessageUrl = null;
  }
}
