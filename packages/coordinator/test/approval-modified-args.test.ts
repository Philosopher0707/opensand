import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unwrapUntrusted } from "@opensand/shared";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { UniversalLLMClient } from "../src/llm-client.js";
import { AgentCoordinator } from "../src/coordinator.js";

// A per-decision edit is a one-off override: it must reach the tool, but never bypass a gate.
describe("coordinator re-gates edited approval args", () => {
  let base: string;
  let dirA: string;
  let dirB: string;
  let daemon: LocalExecDaemon;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-coord-edit-"));
    dirA = path.join(base, "original");
    dirB = path.join(base, "edited");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    fs.writeFileSync(path.join(dirB, "marker.txt"), "edited");
    daemon = new LocalExecDaemon({ stateDir: path.join(base, "state"), heartbeatIntervalMs: 200 });
    daemon.policy.setRule({
      id: "rule_require_dir_edit",
      name: "Require approval for test dirs",
      enabled: true,
      action: "REQUIRE_APPROVAL",
      conditions: { tools: ["list_directory"], pathsPrefix: [base] },
    });
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  function clientListing(args: Record<string, unknown>) {
    return new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: (async (_url: any, init: any): Promise<Response> => {
        const messages = JSON.parse(init.body as string).messages;
        const last = messages[messages.length - 1];
        const chunks = last.role === "tool"
          ? ["data: " + JSON.stringify({ choices: [{ delta: { content: "Done." } }] }) + "\n\n", "data: [DONE]\n\n"]
          : [
              "data: " + JSON.stringify({
                choices: [{ delta: { tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "list_directory", arguments: JSON.stringify(args) } }] } }],
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

  function toolResult(coordinator: AgentCoordinator): any {
    const msg = coordinator.history.find((m) => m.role === "tool");
    return JSON.parse(unwrapUntrusted(String(msg?.content)));
  }

  it("runs the tool with the edited args, not the original ones", async () => {
    let prompts = 0;
    const coordinator = new AgentCoordinator({
      llmClient: clientListing({ path: dirA }),
      daemon,
      sessionsBaseDir: path.join(base, "sessions-edited"),
      onApprovalRequired: async (req) => {
        prompts++;
        assert.deepStrictEqual(req.arguments, { path: dirA });
        req.modifiedArgs = { path: dirB };
        return true;
      },
    });

    await coordinator.runTurn("list the directory");
    assert.equal(prompts, 1);
    const result = toolResult(coordinator);
    assert.ok(result.entries.some((e: { name: string }) => e.name === "marker.txt"),
      `the tool must use the edited path, got ${JSON.stringify(result)}`);
  });

  it("denies an edited path that policy forbids and never executes it", async () => {
    let executions = 0;
    const original = daemon.executeTool.bind(daemon);
    daemon.executeTool = (async (...args: Parameters<typeof original>) => {
      executions++;
      return original(...args);
    }) as typeof daemon.executeTool;

    const coordinator = new AgentCoordinator({
      llmClient: clientListing({ path: dirA }),
      daemon,
      sessionsBaseDir: path.join(base, "sessions-denied"),
      onApprovalRequired: async (req) => {
        req.modifiedArgs = { path: "/etc/passwd" };
        return true;
      },
    });

    await coordinator.runTurn("list the directory");
    const result = toolResult(coordinator);
    assert.equal(result.status, "error");
    assert.equal(result.error.code, "PERMISSION_DENIED");
    assert.equal(result.error.reason, "safety_gate");
    assert.match(result.error.message, /denied by policy/);
    assert.equal(executions, 0, "a re-gated edit must not reach the daemon");
  });

  it("a denial continues the turn with a denial result instead of crashing", async () => {
    const coordinator = new AgentCoordinator({
      llmClient: clientListing({ path: dirA }),
      daemon,
      sessionsBaseDir: path.join(base, "sessions-reject"),
      onApprovalRequired: async () => false,
    });

    const final = await coordinator.runTurn("list the directory");
    assert.equal(final, "Done.");
    const result = toolResult(coordinator);
    assert.equal(result.status, "error");
    assert.equal(result.error.code, "PERMISSION_DENIED");
    assert.equal(result.error.reason, "user_rejected");
  });
});
