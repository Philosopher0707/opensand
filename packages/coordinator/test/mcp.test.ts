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

test("McpClient - streaming SSE protocol handshake and tool execution", async () => {
  const encoder = new TextEncoder();
  let sseController: ReadableStreamDefaultController<Uint8Array>;
  const sseStream = new ReadableStream<Uint8Array>({
    start(controller) {
      sseController = controller;
    },
  });

  const mockFetch = async (url: any, init?: any): Promise<Response> => {
    const urlStr = String(url);
    if (urlStr === "http://localhost:8080/sse") {
      // Send endpoint event
      setTimeout(() => {
        sseController.enqueue(encoder.encode("event: endpoint\ndata: /messages?session=abc123\n\n"));
      }, 5);

      return new Response(sseStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    if (urlStr === "http://localhost:8080/messages?session=abc123") {
      const body = JSON.parse(init.body);
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { serverInfo: { name: "sse-postgres-server", version: "2.0.0" } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 204 });
      }
      if (body.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: "sql_query",
                  description: "Execute SQL query via SSE",
                  inputSchema: { type: "object", properties: { query: { type: "string" } } },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (body.method === "tools/call") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: "pg_stat_activity: 4 active connections" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  };

  const client = new McpClient({
    serverName: "postgres",
    config: {
      url: "http://localhost:8080/sse",
      transport: "sse",
    },
    fetchFn: mockFetch as any,
  });

  await client.start();
  assert.strictEqual(client.running, true);
  assert.strictEqual(client.transport, "sse");

  // Handshake
  const initRes = await client.initialize();
  assert.strictEqual(client.initialized, true);
  assert.strictEqual(initRes.serverInfo.name, "sse-postgres-server");

  // List tools
  const tools = await client.listTools();
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].name, "sql_query");

  // Call tool
  const callRes = await client.callTool("sql_query", { query: "SELECT count(*) FROM pg_stat_activity" });
  assert.strictEqual(callRes.isError, false);
  assert.ok(callRes.content[0].text?.includes("4 active connections"));

  await client.close();
  assert.strictEqual(client.running, false);
});

test("McpClient - asynchronous response delivered over SSE event stream", async () => {
  const encoder = new TextEncoder();
  let sseController: ReadableStreamDefaultController<Uint8Array>;
  const sseStream = new ReadableStream<Uint8Array>({
    start(controller) {
      sseController = controller;
    },
  });

  const mockFetch = async (url: any, init?: any): Promise<Response> => {
    const urlStr = String(url);
    if (urlStr === "http://localhost:8080/sse") {
      setTimeout(() => {
        sseController.enqueue(encoder.encode("event: endpoint\ndata: http://localhost:8080/async-post\n\n"));
      }, 5);

      return new Response(sseStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    if (urlStr === "http://localhost:8080/async-post") {
      const body = JSON.parse(init.body);
      // Return 202 Accepted, and push response onto SSE stream asynchronously
      setTimeout(() => {
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { serverInfo: { name: "async-sse-daemon" } },
        });
        sseController.enqueue(encoder.encode(`event: message\ndata: ${payload}\n\n`));
      }, 20);

      return new Response(null, { status: 202 });
    }

    return new Response("Not found", { status: 404 });
  };

  const client = new McpClient({
    serverName: "async-server",
    config: {
      url: "http://localhost:8080/sse",
      transport: "sse",
    },
    fetchFn: mockFetch as any,
  });

  await client.start();
  const initRes = await client.initialize();
  assert.strictEqual(initRes.serverInfo.name, "async-sse-daemon");
  await client.close();
});

test("McpManager - dynamic server addition, listing, and tool unmounting", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-mcp-dyn-"));
  const configPath = path.join(tmpDir, "mcp.json");
  const mockServer = createMockMcpServer();

  try {
    const daemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "state") });
    await daemon.start();
    await daemon.state.writePermissionGates({ computerUseAllowed: true });

    const manager = new McpManager({ configPath, daemon });

    // Manually register client to simulate dynamic addition
    const client = new McpClient({
      serverName: "analytics",
      customStreams: mockServer.clientStreams,
    });
    await client.start();
    await client.initialize();
    const tools = await client.listTools();

    manager.registerClient("analytics", client, tools, daemon);

    // Verify tools present in daemon
    let defs = daemon.getToolDefinitions();
    assert.ok(defs.some((d) => d.function.name === "analytics__read_query"));

    // Verify server listing
    const servers = await manager.listServers();
    assert.strictEqual(servers.length, 1);
    assert.strictEqual(servers[0].name, "analytics");
    assert.strictEqual(servers[0].status, "connected");
    assert.strictEqual(servers[0].toolCount, 1);
    assert.deepStrictEqual(servers[0].tools, ["read_query"]);

    // Remove server
    const removed = await manager.removeServer("analytics", daemon);
    assert.strictEqual(removed, true);

    // Verify tool unmounted from daemon definitions
    defs = daemon.getToolDefinitions();
    assert.strictEqual(defs.some((d) => d.function.name === "analytics__read_query"), false);

    await manager.closeAll();
    await daemon.stop();
  } finally {
    mockServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("OrchestratorTools - list_mcp_servers, add_mcp_server, remove_mcp_server", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-mcp-orch-"));
  const configPath = path.join(tmpDir, "mcp.json");
  const { registerOrchestratorTools } = await import("../src/orchestrator-tools.js");

  try {
    const daemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "state") });
    await daemon.start();
    await daemon.state.writePermissionGates({ computerUseAllowed: true });

    const mcpManager = new McpManager({ configPath, daemon });
    registerOrchestratorTools({ daemon, mcpManager });

    // Verify tools exist in daemon
    const defs = daemon.getToolDefinitions();
    assert.ok(defs.some((d) => d.function.name === "list_mcp_servers"));
    assert.ok(defs.some((d) => d.function.name === "add_mcp_server"));
    assert.ok(defs.some((d) => d.function.name === "remove_mcp_server"));

    // 1. List initial servers
    const listRes = await daemon.executeTool("list_mcp_servers", {});
    assert.strictEqual(listRes.status, "ok");
    const parsedList = JSON.parse(listRes.output);
    assert.strictEqual(parsedList.total, 0);

    // 2. Remove server
    const removeRes = await daemon.executeTool("remove_mcp_server", { name: "nonexistent" });
    assert.strictEqual(removeRes.status, "ok");
    const parsedRemove = JSON.parse(removeRes.output);
    assert.strictEqual(parsedRemove.removed, true);

    await mcpManager.closeAll();
    await daemon.stop();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TokenHygiene - scopes dynamic MCP tools by capability and role", async () => {
  const { buildToolDiscoverySummary, selectActiveToolsForModel } = await import("../src/token-hygiene.js");

  const mcpTool = {
    type: "function" as const,
    function: {
      name: "postgres__execute_query",
      description: "Run SQL query on Postgres",
      parameters: { type: "object" as const, properties: { query: { type: "string" } } },
    },
  };

  const discovery = buildToolDiscoverySummary([mcpTool]);
  assert.ok(discovery.capabilities.includes("mcp"));
  assert.ok(discovery.capabilities.includes("postgres"));
  assert.strictEqual(discovery.tools[0].capabilities[0], "mcp");
  assert.strictEqual(discovery.tools[0].capabilities[1], "postgres");

  // Model requests capability "mcp"
  const scopedByMcp = selectActiveToolsForModel([mcpTool], ["mcp"]);
  assert.strictEqual(scopedByMcp.length, 1);
  assert.strictEqual(scopedByMcp[0].function.name, "postgres__execute_query");

  // Model requests capability "postgres"
  const scopedByServer = selectActiveToolsForModel([mcpTool], ["postgres"]);
  assert.strictEqual(scopedByServer.length, 1);

  // Model requests irrelevant capability
  const scopedIrrelevant = selectActiveToolsForModel([mcpTool], ["vision"]);
  assert.strictEqual(scopedIrrelevant.length, 0);
});
