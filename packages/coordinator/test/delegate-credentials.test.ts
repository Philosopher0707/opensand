import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import type { ProviderDriver } from "@opensand/shared";
import { AgentStore } from "../src/agent-store.js";
import { SkillStore } from "../src/skill-store.js";
import { registerOrchestratorTools } from "../src/orchestrator-tools.js";
import { providerRegistry } from "../src/provider-registry.js";
import { UniversalLLMClient } from "../src/llm-client.js";

describe("delegate production wiring", () => {
  it("resolves the delegate's key through the driver and inherits skills context", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-delegate-creds-"));
    const previousKey = process.env.TEST_AGENT_API_KEY;
    process.env.TEST_AGENT_API_KEY = "env-agent-key-123";
    let authorization = "";
    const server = http.createServer((req, res) => {
      authorization = String(req.headers.authorization ?? "");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta: { content: "subagent ok" } }] }) + "\n\ndata: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;

    const models = { default: "fake-env-1", options: [{ id: "fake-env-1", label: "Fake" }] };
    const fake: ProviderDriver = {
      driverKind: "fake-env-driver",
      metadata: { displayName: "Fake Env", access: "custom" },
      models,
      decodeConfig: (raw) => raw,
      defaultConfig: () => ({ apiKeyEnv: "TEST_AGENT_API_KEY" }),
      async create(input) {
        const env = (input.environment ?? {}) as Record<string, string>;
        return {
          instanceId: input.instanceId,
          driverKind: "fake-env-driver",
          displayName: input.displayName,
          enabled: input.enabled,
          models,
          adapter: {
            provider: "fake-env-driver",
            capabilities: {},
            async sendTurn() { return { text: "unused", toolCalls: [] }; },
            steer: () => Promise.resolve(),
            interruptTurn: () => Promise.resolve(),
            respondToRequest: () => Promise.resolve("unavailable" as const),
            hasSession: () => false,
            enginePid: () => undefined,
            stopAll: () => Promise.resolve(),
            onEvent: () => () => {},
          },
          createLlmClient: () => new UniversalLLMClient({
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "fake-env-1",
            apiKey: env.TEST_AGENT_API_KEY || process.env.TEST_AGENT_API_KEY,
          }),
          snapshot: async () => ({ instanceId: input.instanceId, driverKind: "fake-env-driver", enabled: input.enabled }),
          dispose: () => Promise.resolve(),
        };
      },
    };
    providerRegistry.register(fake);

    const daemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "state") });
    await daemon.start();
    await daemon.state.writePermissionGates({ computerUseAllowed: true });
    const sessionsBaseDir = path.join(tmpDir, "sessions");
    try {
      const store = new AgentStore(path.join(tmpDir, "agents"));
      const skillStore = new SkillStore({ agentStore: store });
      (skillStore as any).formatSkillsPrompt = async () => "SKILL_CONTEXT_MARKER";
      registerOrchestratorTools({
        daemon,
        store,
        skillStore,
        defaultEndpoint: `http://127.0.0.1:${port}/v1`,
        defaultModel: "fake-env-1",
        defaultApiKey: "none",
        defaultProvider: "fake-env-driver",
        sessionsBaseDir,
      });
      const agent = await store.createAgent({
        name: "Env Bot",
        role: "Research Assistant",
        systemPrompt: "You research things.",
      });
      const res = await daemon.executeTool("delegate_to_agent", {
        agent_id_or_name: agent.id,
        task: "do research",
      });
      assert.strictEqual(res.status, "ok");
      assert.strictEqual(authorization, "Bearer env-agent-key-123", "env key must reach the delegate client");

      const childDirs = fs.readdirSync(sessionsBaseDir).filter((name) => name.startsWith("sub_"));
      assert.ok(childDirs.length >= 1, "a child session must be created");
      const log = fs.readFileSync(path.join(sessionsBaseDir, childDirs[0], "event-log.jsonl"), "utf8");
      assert.ok(log.includes("SKILL_CONTEXT_MARKER"), "skills context must be injected into the child prompt");
    } finally {
      await daemon.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (previousKey === undefined) delete process.env.TEST_AGENT_API_KEY;
      else process.env.TEST_AGENT_API_KEY = previousKey;
      await providerRegistry.disposeAll();
    }
  });

  it("uses the live key getter, not the startup snapshot, for delegate credentials", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-delegate-livekey-"));
    let authorization = "";
    const server = http.createServer((req, res) => {
      authorization = String(req.headers.authorization ?? "");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + "\n\ndata: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    const models = { default: "live-1", options: [{ id: "live-1", label: "Live" }] };
    const driver: ProviderDriver = {
      driverKind: "fake-live-driver",
      metadata: { displayName: "Fake Live", access: "api" },
      models,
      decodeConfig: (raw) => raw,
      defaultConfig: () => ({ apiKeyEnv: "TEST_LIVE_KEY" }),
      async create(input) {
        const env = (input.environment ?? {}) as Record<string, string>;
        return {
          instanceId: input.instanceId,
          driverKind: "fake-live-driver",
          displayName: input.displayName,
          enabled: input.enabled,
          models,
          adapter: {
            provider: "fake-live-driver",
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
          createLlmClient: () => new UniversalLLMClient({
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "live-1",
            apiKey: env.TEST_LIVE_KEY,
          }),
          snapshot: async () => ({ instanceId: input.instanceId, driverKind: "fake-live-driver", enabled: input.enabled }),
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
      registerOrchestratorTools({
        daemon,
        store,
        defaultEndpoint: `http://127.0.0.1:${port}/v1`,
        defaultModel: "live-1",
        defaultApiKey: "none",
        defaultProvider: "fake-live-driver",
        resolveApiKey: () => "live-vault-key-xyz",
        sessionsBaseDir: path.join(tmpDir, "sessions"),
      });
      const agent = await store.createAgent({ name: "Live Bot", role: "Assistant", systemPrompt: "x" });
      const result = await daemon.executeTool("delegate_to_agent", { agent_id_or_name: agent.id, task: "work" });
      assert.strictEqual(result.status, "ok");
      assert.strictEqual(authorization, "Bearer live-vault-key-xyz", "delegate must use the live key, not the startup snapshot");
    } finally {
      await daemon.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await providerRegistry.disposeAll();
    }
  });

  it("propagates parent cancellation to the child and bounds the delegation registry", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-delegate-lifecycle-"));
    let mode: "hang" | "fast" = "hang";
    const server = http.createServer((_req, res) => {
      if (mode === "hang") {
        setTimeout(() => res.end(), 5_000);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + "\n\ndata: [DONE]\n\n");
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
        defaultModel: "mock-lifecycle",
        sessionsBaseDir: path.join(tmpDir, "sessions"),
      });
      const agent = await store.createAgent({ name: "Lifecycle Bot", role: "Research Assistant", systemPrompt: "work" });

      const controller = new AbortController();
      const started = await daemon.executeTool("delegate_to_agent", {
        agent_id_or_name: agent.id,
        task: "long task",
        background: true,
      }, { signal: controller.signal });
      const sessionId = JSON.parse(started.output).subagent.sessionId;
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const collected = await daemon.executeTool("await_agent", { agent_id: sessionId, timeout_ms: 100 });
      assert.strictEqual(JSON.parse(collected.output).status, "cancelled");

      // Bounded registry: after more than the cap, the oldest settled entry is gone.
      mode = "fast";
      const first = await daemon.executeTool("delegate_to_agent", { agent_id_or_name: agent.id, task: "one" });
      const firstId = JSON.parse(first.output).subagent.sessionId;
      for (let i = 0; i < 258; i++) {
        await daemon.executeTool("delegate_to_agent", { agent_id_or_name: agent.id, task: `fill ${i}` });
      }
      const pruned = await daemon.executeTool("await_agent", { agent_id: firstId });
      assert.strictEqual(JSON.parse(pruned.output).status, "not_found");
    } finally {
      await daemon.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
