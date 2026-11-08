import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { McpClient, McpServerConfig, McpToolDefinition, McpTransport } from "./mcp-client.js";
import { LocalExecDaemon, ToolDefinition } from "@opensand/local-exec-daemon";

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

export interface McpServerSummary {
  name: string;
  transport: McpTransport;
  status: "connected" | "disconnected" | "error";
  command?: string;
  url?: string;
  toolCount: number;
  tools: string[];
}

export interface McpManagerOptions {
  configPath?: string;
  config?: McpConfigFile;
  daemon?: LocalExecDaemon;
}

export class McpManager {
  private configPath: string;
  private inMemoryConfig?: McpConfigFile;
  private daemon?: LocalExecDaemon;
  private clients = new Map<string, McpClient>();
  private serverTools = new Map<string, McpToolDefinition[]>();

  constructor(options: McpManagerOptions = {}) {
    this.configPath = options.configPath ?? path.join(os.homedir(), ".opensand", "mcp.json");
    this.inMemoryConfig = options.config;
    this.daemon = options.daemon;
  }

  get activeClients(): Map<string, McpClient> {
    return this.clients;
  }

  /**
   * Load MCP server definitions from file or in-memory config.
   */
  async loadConfig(): Promise<McpConfigFile> {
    if (this.inMemoryConfig) {
      return this.inMemoryConfig;
    }

    try {
      const text = await fs.readFile(this.configPath, "utf-8");
      return JSON.parse(text) as McpConfigFile;
    } catch {
      return { mcpServers: {} };
    }
  }

  /**
   * Save MCP server definitions to configuration file.
   */
  async saveConfig(config: McpConfigFile): Promise<void> {
    if (this.inMemoryConfig) {
      this.inMemoryConfig = config;
      return;
    }

    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.configPath}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmp, this.configPath);
  }

  /**
   * Start and register all configured MCP servers.
   */
  async startAll(daemon?: LocalExecDaemon): Promise<number> {
    const targetDaemon = daemon ?? this.daemon;
    const config = await this.loadConfig();
    const servers = config.mcpServers || {};

    let registeredCount = 0;

    for (const [serverName, serverConfig] of Object.entries(servers)) {
      try {
        const client = new McpClient({
          serverName,
          config: serverConfig,
        });

        await client.start();
        await client.initialize();
        const tools = await client.listTools();

        this.clients.set(serverName, client);
        this.serverTools.set(serverName, tools);

        if (targetDaemon) {
          this.registerServerTools(serverName, client, tools, targetDaemon);
        }

        registeredCount += tools.length;
      } catch (err) {
        console.warn(`[McpManager] Failed to start MCP server [${serverName}]:`, err instanceof Error ? err.message : err);
      }
    }

    return registeredCount;
  }

  /**
   * Add or update an MCP server, connect it immediately, and mount its tools.
   */
  async addServer(
    serverName: string,
    serverConfig: McpServerConfig,
    daemon?: LocalExecDaemon
  ): Promise<McpToolDefinition[]> {
    const targetDaemon = daemon ?? this.daemon;

    // Remove existing client if present
    if (this.clients.has(serverName)) {
      await this.removeServer(serverName, targetDaemon);
    }

    const client = new McpClient({
      serverName,
      config: serverConfig,
    });

    await client.start();
    await client.initialize();
    const tools = await client.listTools();

    this.clients.set(serverName, client);
    this.serverTools.set(serverName, tools);

    if (targetDaemon) {
      this.registerServerTools(serverName, client, tools, targetDaemon);
    }

    // Persist to configuration
    const config = await this.loadConfig();
    if (!config.mcpServers) {
      config.mcpServers = {};
    }
    config.mcpServers[serverName] = serverConfig;
    await this.saveConfig(config);

    return tools;
  }

  /**
   * Remove and disconnect an MCP server, unmounting its tools.
   */
  async removeServer(serverName: string, daemon?: LocalExecDaemon): Promise<boolean> {
    const targetDaemon = daemon ?? this.daemon;
    const client = this.clients.get(serverName);

    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore errors on closing
      }
      this.clients.delete(serverName);
    }

    if (targetDaemon) {
      const registeredTools = this.serverTools.get(serverName) || [];
      for (const tool of registeredTools) {
        targetDaemon.unregisterCustomTool(`${serverName}__${tool.name}`);
      }
    }
    this.serverTools.delete(serverName);

    // Update persisted configuration
    const config = await this.loadConfig();
    if (config.mcpServers && config.mcpServers[serverName]) {
      delete config.mcpServers[serverName];
      await this.saveConfig(config);
    }

    return true;
  }

  /**
   * List all configured and active MCP servers.
   */
  async listServers(): Promise<McpServerSummary[]> {
    const config = await this.loadConfig();
    const servers = config.mcpServers || {};
    const result: McpServerSummary[] = [];

    const allNames = new Set([...Object.keys(servers), ...this.clients.keys()]);

    for (const name of allNames) {
      const cfg = servers[name];
      const client = this.clients.get(name);
      const tools = this.serverTools.get(name) || [];

      const transport: McpTransport = client?.transport ?? cfg?.transport ?? (cfg?.url ? "sse" : "stdio");
      const status: "connected" | "disconnected" | "error" = client?.running ? "connected" : "disconnected";

      result.push({
        name,
        transport,
        status,
        command: cfg?.command,
        url: cfg?.url,
        toolCount: tools.length,
        tools: tools.map((t) => t.name),
      });
    }

    return result;
  }

  /**
   * Get cached tool definitions for a server.
   */
  getServerTools(serverName: string): McpToolDefinition[] {
    return this.serverTools.get(serverName) || [];
  }

  /**
   * Get the active McpClient for a server.
   */
  getServerClient(serverName: string): McpClient | undefined {
    return this.clients.get(serverName);
  }

  /**
   * Register a manual client (e.g. for testing with mock streams).
   */
  registerClient(
    serverName: string,
    client: McpClient,
    tools: McpToolDefinition[],
    daemon?: LocalExecDaemon
  ): void {
    const targetDaemon = daemon ?? this.daemon;
    this.clients.set(serverName, client);
    this.serverTools.set(serverName, tools);

    if (targetDaemon) {
      this.registerServerTools(serverName, client, tools, targetDaemon);
    }
  }

  /**
   * Register tools from an MCP client into the LocalExecDaemon.
   */
  private registerServerTools(
    serverName: string,
    client: McpClient,
    tools: McpToolDefinition[],
    daemon: LocalExecDaemon
  ): void {
    for (const tool of tools) {
      const qualifiedName = `${serverName}__${tool.name}`;
      const definition: ToolDefinition = {
        type: "function",
        function: {
          name: qualifiedName,
          description: `[MCP: ${serverName}] ${tool.description ?? ""}`.trim(),
          parameters: (tool.inputSchema as any) || { type: "object", properties: {} },
        },
      };

      daemon.registerCustomTool({
        definition,
        requiresGate: "computerUse",
        handler: async (args) => {
          const result = await client.callTool(tool.name, args);
          if (result.isError) {
            const errorMsg = result.content
              .filter((c) => c.type === "text" && c.text)
              .map((c) => c.text)
              .join("\n");
            throw new Error(errorMsg || `MCP tool [${tool.name}] reported execution failure`);
          }

          // Format output text
          const texts = result.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text);

          if (texts.length > 0) {
            return texts.join("\n");
          }

          return JSON.stringify(result.content);
        },
      });
    }
  }

  /**
   * Stop all active MCP clients.
   */
  async closeAll(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.clients.clear();
    this.serverTools.clear();
  }
}
