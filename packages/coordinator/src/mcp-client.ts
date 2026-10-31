import { ChildProcess, spawn } from "node:child_process";
import * as readline from "node:readline";
import { Readable, Writable } from "node:stream";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
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
}

export class McpClient {
  public readonly serverName: string;
  private config?: McpServerConfig;
  private customStreams?: { stdin: Writable; stdout: Readable };
  private process: ChildProcess | null = null;
  private stdin: Writable | null = null;
  private stdout: Readable | null = null;
  private rl: readline.Interface | null = null;

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
  }

  get running(): boolean {
    return this.process !== null || this.customStreams !== undefined;
  }

  get initialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Start the MCP server process and establish stdio communication.
   */
  async start(): Promise<void> {
    if (this.customStreams) {
      this.stdin = this.customStreams.stdin;
      this.stdout = this.customStreams.stdout;
    } else if (this.config) {
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
    } else {
      throw new Error(`MCP client [${this.serverName}] requires either config or customStreams`);
    }

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
   * Send a JSON-RPC request and wait for the response.
   */
  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<any> {
    if (!this.stdin) {
      throw new Error(`MCP server [${this.serverName}] is not running`);
    }

    const id = this.nextRequestId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

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
    if (!this.stdin) {
      throw new Error(`MCP server [${this.serverName}] is not running`);
    }

    const payload: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const line = JSON.stringify(payload) + "\n";
    return new Promise((resolve, reject) => {
      this.stdin?.write(line, "utf-8", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Process a single incoming line from stdout.
   */
  private handleIncomingLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Ignore non-JSON output (e.g. server debug logging to stdout)
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
   * Gracefully terminate the MCP client and child process.
   */
  async close(): Promise<void> {
    this.rejectAllPending(new Error(`MCP client [${this.serverName}] closed`));

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
  }
}
