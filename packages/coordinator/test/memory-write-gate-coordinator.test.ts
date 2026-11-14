import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { UniversalLLMClient } from "../src/llm-client.js";
import { AgentCoordinator } from "../src/coordinator.js";
import { MemoryStore } from "../src/memory-store.js";
import { registerOrchestratorTools } from "../src/orchestrator-tools.js";

// End to end: a model's update_memory call reaches a person through onApprovalRequired, and only a yes persists it.
describe("coordinator asks a person before the model persists memory", () => {
  let base: string;
  let store: MemoryStore;
  let daemon: LocalExecDaemon;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-coord-memgate-"));
    store = new MemoryStore({ baseDir: path.join(base, "mem") });
    daemon = new LocalExecDaemon({ stateDir: path.join(base, "state"), heartbeatIntervalMs: 200 });
    registerOrchestratorTools({ daemon, memoryStore: store });
    await daemon.start();
  });
  afterEach(async () => {
    await daemon.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  function clientWriting(args: Record<string, unknown>) {
    return new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: (async (_url: any, init: any): Promise<Response> => {
        const messages = JSON.parse(init.body as string).messages;
        const last = messages[messages.length - 1];
        const chunks =
          last.role === "tool"
            ? ["data: " + JSON.stringify({ choices: [{ delta: { content: "Done." } }] }) + "\n\n", "data: [DONE]\n\n"]
            : [
                "data: " +
                  JSON.stringify({
                    choices: [{ delta: { tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "update_memory", arguments: JSON.stringify(args) } }] } }],
                  }) + "\n\n",
                "data: [DONE]\n\n",
              ];
        const enc = new TextEncoder();
        return new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as any,
    });
  }

  const call = { action: "write", text: "Prefers tabs", scope: "user", tier: "log" };

  it("a rejected prompt stores nothing", async () => {
    let prompts = 0;
    const c = new AgentCoordinator({
      llmClient: clientWriting(call), daemon, sessionsBaseDir: path.join(base, "sessions"),
      onApprovalRequired: async (req) => { prompts++; assert.equal(req.toolName, "update_memory"); return false; },
    });
    await c.runTurn("remember");
    assert.equal(prompts, 1);
    assert.deepEqual(await store.listMemories({ scope: "user" }), []);
  });

  it("an approved prompt stores the fact", async () => {
    let prompts = 0;
    const c = new AgentCoordinator({
      llmClient: clientWriting(call), daemon, sessionsBaseDir: path.join(base, "sessions"),
      onApprovalRequired: async () => { prompts++; return true; },
    });
    await c.runTurn("remember");
    assert.equal(prompts, 1);
    assert.equal((await store.listMemories({ scope: "user" })).length, 1);
  });

  it("with no approver wired the write is not stored (fails closed)", async () => {
    const c = new AgentCoordinator({ llmClient: clientWriting(call), daemon, sessionsBaseDir: path.join(base, "sessions") });
    await c.runTurn("remember");
    assert.deepEqual(await store.listMemories({ scope: "user" }), []);
  });
});
