import * as http from "node:http";
import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AgentStore } from "../src/agent-store.js";
import { registerOrchestratorTools } from "../src/orchestrator-tools.js";
import { buildToolDiscoverySummary } from "../src/token-hygiene.js";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";

test("AgentStore - creates, lists, updates, and deletes agent personas", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-agent-store-"));

  try {
    const store = new AgentStore(tmpDir);

    // 1. Create Agent
    const cto = await store.createAgent({
      name: "CTO Bot",
      role: "Chief Technology Officer & Principal Software Architect",
      systemPrompt: "Enforce modularity, YAGNI, and architectural health.",
      model: "qwen3:8b",
      allowedTools: ["exec_command", "read_file", "list_directory"],
    });

    assert.ok(cto.id.startsWith("agent_cto_bot_"));
    assert.strictEqual(cto.name, "CTO Bot");
    assert.strictEqual(cto.role, "Chief Technology Officer & Principal Software Architect");

    // 2. Get Agent by ID and Name
    const byId = await store.getAgent(cto.id);
    assert.ok(byId);
    assert.strictEqual(byId?.name, "CTO Bot");

    const byName = await store.getAgent("cto bot");
    assert.ok(byName);
    assert.strictEqual(byName?.id, cto.id);

    // 3. List Agents
    const all = await store.listAgents();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].id, cto.id);

    // 4. Update Agent
    const updated = await store.updateAgent(cto.id, {
      model: "claude-3-7-sonnet",
    });
    assert.strictEqual(updated.model, "claude-3-7-sonnet");

    // 5. Delete Agent
    const deleted = await store.deleteAgent(cto.id);
    assert.strictEqual(deleted, true);

    const recheck = await store.getAgent(cto.id);
    assert.strictEqual(recheck, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AgentStore - exports and imports agent templates (GrokBotTemplate parity)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-template-test-"));

  try {
    const store = new AgentStore(tmpDir);

    const qaAgent = await store.createAgent({
      name: "QA Lead",
      role: "Lead QA Automation Engineer",
      systemPrompt: "Design edge-case reproduction tests and ensure zero regressions.",
      allowedTools: ["exec_command", "read_file"],
      metadata: { description: "QA Lead template", tier: "lead" },
    });

    // Export template
    const template = await store.exportTemplate(qaAgent.id);
    assert.strictEqual(template.templateVersion, "1.0.0");
    assert.strictEqual(template.name, "QA Lead");
    assert.strictEqual(template.role, "Lead QA Automation Engineer");
    assert.strictEqual(template.description, "QA Lead template");
    assert.deepStrictEqual(template.allowedTools, ["exec_command", "read_file"]);

    // Import template into another instance or as new agent
    const imported = await store.importTemplate(template);
    assert.ok(imported.id.startsWith("agent_qa_lead_"));
    assert.strictEqual(imported.name, "QA Lead");
    assert.strictEqual(imported.metadata?.importedFromTemplate, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("OrchestratorTools - registers meta-tools into daemon and executes create_agent & list_agents", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-orch-tools-"));

  try {
    const daemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "state") });
    await daemon.start();
    await daemon.state.writePermissionGates({ computerUseAllowed: true });

    const store = new AgentStore(path.join(tmpDir, "agents"));
    registerOrchestratorTools({
      daemon,
      store,
      sessionsBaseDir: path.join(tmpDir, "sessions"),
    });

    // 1. Verify meta-tools registered in daemon definitions
    const defs = daemon.getToolDefinitions();
    const toolNames = defs.map((d) => d.function.name);
    assert.ok(toolNames.includes("create_agent"));
    assert.ok(toolNames.includes("list_agents"));
    assert.ok(toolNames.includes("delegate_to_agent"));
    assert.ok(toolNames.includes("get_agent_tail"));
    assert.ok(toolNames.includes("discover_tools"));

    // 2. Execute create_agent tool through daemon
    const createRes = await daemon.executeTool("create_agent", {
      name: "Security Auditor",
      role: "Application Security Engineer",
      system_prompt: "Scan for command injections and secret leaks.",
      model: "deepseek-coder",
    });

    assert.strictEqual(createRes.status, "ok");
    const createdPayload = JSON.parse(createRes.output);
    assert.strictEqual(createdPayload.status, "success");
    assert.strictEqual(createdPayload.agent.name, "Security Auditor");

    // 3. Execute list_agents tool through daemon
    const listRes = await daemon.executeTool("list_agents", {});
    assert.strictEqual(listRes.status, "ok");
    const listPayload = JSON.parse(listRes.output);
    assert.strictEqual(listPayload.length, 1);
    assert.strictEqual(listPayload[0].name, "Security Auditor");

    // 4. Execute discover_tools tool through daemon (Grok Bot DiscoverAiTool parity)
    const discoverRes = await daemon.executeTool("discover_tools", {});
    assert.strictEqual(discoverRes.status, "ok");
    const discoverPayload = JSON.parse(discoverRes.output);
    assert.ok(discoverPayload.totalTools >= 5);
    assert.strictEqual(discoverPayload.totalTools, discoverPayload.tools.length);
    assert.ok(discoverPayload.tools.some((t: any) => t.name === "create_agent"));
    assert.ok(Array.isArray(discoverPayload.capabilities));
    assert.ok(discoverPayload.capabilities.includes("core"));
    assert.deepStrictEqual(discoverPayload, buildToolDiscoverySummary(daemon.getToolDefinitions()));

    await daemon.stop();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("delegate_to_agent scopes subagent tools by fallback role defaults and explicit allowedTools", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-delegate-scope-"));
  let capturedTools: any[] = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        capturedTools = payload.tools || [];
      } catch {
        capturedTools = [];
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta: { content: "Subagent completed task." } }] }) + "\n\ndata: [DONE]\n\n");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;

  const daemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "state") });
  await daemon.start();
  await daemon.state.writePermissionGates({ computerUseAllowed: true });

  try {
    const store = new AgentStore(path.join(tmpDir, "agents"));
    registerOrchestratorTools({
      daemon,
      store,
      defaultEndpoint: `http://127.0.0.1:${port}/v1`,
      defaultModel: "mock-subagent-model",
      sessionsBaseDir: path.join(tmpDir, "sessions"),
    });

    // 1. Agent with role "Senior Application Security Engineer" and NO explicit allowedTools
    const secAgent = await store.createAgent({
      name: "SecuritySpecialist",
      role: "Senior Application Security Engineer",
      systemPrompt: "Audit secrets and vulnerabilities.",
    });

    const res1 = await daemon.executeTool("delegate_to_agent", {
      agent_id_or_name: secAgent.id,
      task: "Audit repo for leaks",
    });
    assert.strictEqual(res1.status, "ok");
    const payload1 = JSON.parse(res1.output);
    assert.strictEqual(payload1.status, "completed");
    assert.strictEqual(payload1.response, "Subagent completed task.");

    // Verify subagent tools sent to LLM match fallback role tools for security
    const toolNames1 = capturedTools.map((t: any) => t.function.name).sort();
    assert.deepStrictEqual(toolNames1, ["exec_command", "glob", "grep", "list_directory", "read_file", "vault_list_secrets"]);

    // 2. Agent with explicit allowedTools whitelist: ["read_file"]
    const strictAgent = await store.createAgent({
      name: "StrictReader",
      role: "Senior Application Security Engineer",
      systemPrompt: "Read only",
      allowedTools: ["read_file"],
    });

    const res2 = await daemon.executeTool("delegate_to_agent", {
      agent_id_or_name: strictAgent.id,
      task: "Inspect readme",
    });
    assert.strictEqual(res2.status, "ok");
    const payload2 = JSON.parse(res2.output);
    assert.strictEqual(payload2.status, "completed");

    // Verify subagent tools sent to LLM are strictly constrained to explicit allowedTools
    const toolNames2 = capturedTools.map((t: any) => t.function.name);
    assert.deepStrictEqual(toolNames2, ["read_file"]);
  } finally {
    await daemon.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
