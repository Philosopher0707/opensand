import test from "node:test";
import * as assert from "node:assert";
import { PassThrough } from "node:stream";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { McpClient, McpToolDefinition } from "../src/mcp-client.js";
import { McpManager } from "../src/mcp-manager.js";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";

// Helper to simulate an MCP Server using PassThrough streams
function createMockMcpServer() {
  const clientStdin = new PassThrough();  // Client writes here, mock server reads
  const clientStdout = new PassThrough(); // Mock server writes here, client reads

  const serverRl = readline.createInterface({
    input: clientStdin,
    crlfDelay: Infinity,
  });

  serverRl.on("line", (line) => {
    try {
      const req = JSON.parse(line);
      if (req.method === "initialize") {
        const res = {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "mock-sqlite-server", version: "1.0.0" },
          },
        };
        clientStdout.write(JSON.stringify(res) + "\n");
      } else if (req.method === "tools/list") {
        const res = {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            tools: [
              {
                name: "read_query",
                description: "Execute a SELECT SQL query",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              },
            ],
          },
        };
        clientStdout.write(JSON.stringify(res) + "\n");
      } else if (req.method === "tools/call") {
        if (req.params.name === "read_query") {
          const res = {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify([{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }]),
                },
              ],
            },
          };
          clientStdout.write(JSON.stringify(res) + "\n");
        } else {
          const res = {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32601, message: "Method not found" },
          };
          clientStdout.write(JSON.stringify(res) + "\n");
        }
      }
    } catch {
      // Ignore
    }
  });

  return {
    clientStreams: {
      stdin: clientStdin,
      stdout: clientStdout,
    },
    close: () => {
      serverRl.close();
      clientStdin.end();
      clientStdout.end();
    },
  };
}

test("McpClient - performs JSON-RPC 2.0 handshake, lists tools, and calls tools", async () => {
  const mockServer = createMockMcpServer();

  try {
    const client = new McpClient({
      serverName: "sqlite",
      customStreams: mockServer.clientStreams,
    });

    await client.start();
    assert.strictEqual(client.running, true);

    // 1. Handshake
    const initRes = await client.initialize();
    assert.strictEqual(client.initialized, true);
    assert.strictEqual(initRes.serverInfo.name, "mock-sqlite-server");

    // 2. List tools
    const tools = await client.listTools();
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, "read_query");
    assert.strictEqual(tools[0].description, "Execute a SELECT SQL query");

    // 3. Call tool
    const callRes = await client.callTool("read_query", { query: "SELECT * FROM users" });
    assert.strictEqual(callRes.isError, false);
    assert.strictEqual(callRes.content[0].type, "text");
    assert.ok(callRes.content[0].text?.includes("Alice"));

    await client.close();
    assert.strictEqual(client.initialized, false);
  } finally {
    mockServer.close();
  }
});

test("McpManager - integrates MCP tools into LocalExecDaemon with dual-mode gates", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-mcp-test-"));
  const mockServer = createMockMcpServer();

  try {
    const daemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "state") });
    await daemon.start();

    // Set permission gates so computerUse is allowed
    await daemon.state.writePermissionGates({ computerUseAllowed: true });

    const client = new McpClient({
      serverName: "db",
      customStreams: mockServer.clientStreams,
    });
    await client.start();
    await client.initialize();
    const tools = await client.listTools();

    const manager = new McpManager({ daemon });
    manager.registerClient("db", client, tools, daemon);

    // Verify tool registered in daemon definitions
    const defs = daemon.getToolDefinitions();
    const mcpTool = defs.find((d) => d.function.name === "db__read_query");
    assert.ok(mcpTool);
    assert.strictEqual(mcpTool.function.description, "[MCP: db] Execute a SELECT SQL query");

    // Execute tool through daemon
    const result = await daemon.executeTool("db__read_query", { query: "SELECT * FROM users" });
    assert.strictEqual(result.status, "ok");
    assert.ok(result.output.includes("Alice"));

    await manager.closeAll();
    await daemon.stop();
  } finally {
    mockServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("McpManager - loads and saves config files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-mcp-cfg-"));
  const configPath = path.join(tmpDir, "mcp.json");

  try {
    const manager = new McpManager({ configPath });

    // Empty by default
    const initial = await manager.loadConfig();
    assert.deepStrictEqual(initial, { mcpServers: {} });

    // Save configuration
    await manager.saveConfig({
      mcpServers: {
        github: {
          command: "npx",
          args: ["@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "mock_token" },
        },
      },
    });

    // Reload
    const reloaded = await manager.loadConfig();
    assert.ok(reloaded.mcpServers?.github);
    assert.strictEqual(reloaded.mcpServers?.github.command, "npx");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
