import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import type { ProviderDriver } from "@opensand/shared";
import { AgentStore } from "../src/agent-store.js";
import { registerOrchestratorTools } from "../src/orchestrator-tools.js";
import { providerRegistry } from "../src/provider-registry.js";

describe("assistant agent-management tools", () => {
  it("creates, configures and deletes a bot with provider/model/system prompt through tools", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-agent-tools-"));
    const models = { default: "m1", options: [{ id: "m1", label: "M1" }] };
    const driver: ProviderDriver = {
      driverKind: "tool-driver",
      metadata: { displayName: "Tool Driver", access: "api" },
      models,
      decodeConfig: (raw) => raw,
      defaultConfig: () => ({}),
      async create(input) {
        return {
          instanceId: input.instanceId,
          driverKind: "tool-driver",
          displayName: input.displayName,
          enabled: input.enabled,
          models,
          adapter: {
            provider: "tool-driver",
            capabilities: {},
            async sendTurn() { return { text: "", toolCalls: [] }; },
            steer: () => Promise.resolve(),
            interruptTurn: () => Promise.resolve(),
            respondToRequest: () => Promise.resolve("unavailable" as const),
            hasSession: () => false,
            enginePid: () => undefined,
            stopAll: () => Promise.resolve(),
            onEvent: () => () => {},
          },
          snapshot: async () => ({ instanceId: input.instanceId, driverKind: "tool-driver", enabled: input.enabled }),
          dispose: () => Promise.resolve(),
        };
      },
    };
    providerRegistry.register(driver);
    const daemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "state") });
    await daemon.start();
    await daemon.state.writePermissionGates({ computerUseAllowed: true });
    try {
      const store = new AgentStore(path.join(tmpDir, "agents"));
      registerOrchestratorTools({ daemon, store, sessionsBaseDir: path.join(tmpDir, "sessions") });
      const names = daemon.getToolDefinitions().map((d) => d.function.name);
      for (const name of ["create_agent", "list_agents", "configure_agent", "delete_agent"]) {
        assert.ok(names.includes(name), `${name} must be exposed to the assistant`);
      }

      const created = await daemon.executeTool("create_agent", {
        name: "Tool Bot",
        role: "Research Assistant",
        system_prompt: "You research things.",
        provider: "tool-driver",
        model: "m1",
        endpoint: "https://example.com/v1",
      });
      assert.strictEqual(created.status, "ok");
      const createdPayload = JSON.parse(created.output);
      assert.strictEqual(createdPayload.agent.provider, "tool-driver");
      assert.strictEqual(createdPayload.agent.model, "m1");
      const botId = createdPayload.agent.id;

      const configured = await daemon.executeTool("configure_agent", {
        agent: botId,
        provider: "",
        model: "m2",
        system_prompt: "You are a concise researcher.",
      });
      assert.strictEqual(configured.status, "ok");
      const configuredPayload = JSON.parse(configured.output);
      assert.strictEqual(configuredPayload.agent.provider, "global", "empty provider means follow global");
      assert.strictEqual(configuredPayload.agent.systemPrompt, "You are a concise researcher.");
      const reread = await store.getAgent(botId);
      assert.strictEqual(reread?.model, "m2");
      assert.strictEqual(reread?.systemPrompt, "You are a concise researcher.");

      const refused = await daemon.executeTool("delete_agent", { agent: botId });
      assert.strictEqual(JSON.parse(refused.output).status, "confirmation_required");
      assert.ok(await store.getAgent(botId), "bot must survive without confirmation");

      const deleted = await daemon.executeTool("delete_agent", { agent: botId, confirm: true });
      assert.strictEqual(JSON.parse(deleted.output).status, "success");
      assert.strictEqual(await store.getAgent(botId), null);

      const unknown = await daemon.executeTool("create_agent", {
        name: "Bad", role: "x", system_prompt: "x", provider: "not-registered",
      });
      assert.strictEqual(unknown.status, "error", "unknown provider must fail closed");
    } finally {
      await daemon.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await providerRegistry.disposeAll();
    }
  });
});
