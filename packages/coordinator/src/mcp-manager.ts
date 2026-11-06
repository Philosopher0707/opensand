import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { McpClient, McpServerConfig, McpToolDefinition } from "./mcp-client.js";
import { LocalExecDaemon, ToolDefinition } from "@opensand/local-exec-daemon";

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
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
   * Register a manual client (e.g. for testing with mock streams).
   */
  registerClient(serverName: string, client: McpClient, tools: McpToolDefinition[], daemon?: LocalExecDaemon): void {
    const targetDaemon = daemon ?? this.daemon;
    this.clients.set(serverName, client);

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
  }
}
