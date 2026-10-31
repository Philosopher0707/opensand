import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AgentStore } from "../src/agent-store.js";
import { registerOrchestratorTools } from "../src/orchestrator-tools.js";
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
    assert.ok(discoverPayload.tools.some((t: any) => t.name === "create_agent"));

    await daemon.stop();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
