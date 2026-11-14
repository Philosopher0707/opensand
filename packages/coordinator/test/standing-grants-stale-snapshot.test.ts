import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unwrapUntrusted, GrantsStore } from "@opensand/shared";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { UniversalLLMClient } from "../src/llm-client.js";
import { AgentCoordinator } from "../src/coordinator.js";

// The coordinator decides standing exec permission from <base>/grants.json through the shared matcher,
// and re-checks the grants epoch right before it spawns. Own base dir and try/finally-style cleanup per test.
describe("coordinator standing exec permission comes from grants.json", () => {
  let base: string;
  let store: GrantsStore;
  let daemon: LocalExecDaemon;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-coord-grants-"));
    store = new GrantsStore({ baseDir: base });
    daemon = new LocalExecDaemon({ stateDir: path.join(base, "state"), heartbeatIntervalMs: 200 });
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  /** A model that asks for the given exec_command calls in one turn, then says Done. */
  function clientCalling(commands: string[]) {
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
                    choices: [
                      {
                        delta: {
                          tool_calls: commands.map((command, index) => ({
                            index,
                            id: `call_${index}`,
                            type: "function",
                            function: { name: "exec_command", arguments: JSON.stringify({ command }) },
                          })),
                        },
                      },
                    ],
                  }) +
                  "\n\n",
                "data: [DONE]\n\n",
              ];
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(c) {
              for (const ch of chunks) c.enqueue(encoder.encode(ch));
              c.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }) as any,
    });
  }

  const toolResults = (coordinator: AgentCoordinator) =>
    coordinator.history.filter((m) => m.role === "tool").map((m) => JSON.parse(unwrapUntrusted(String(m.content))));

  it("denies a command whose grant was revoked between the gate snapshot and the spawn", async () => {
    const marker = path.join(base, "ran-after-revoke");
    const touchGrant = await store.addGrant({ tool: "exec_command", scope: "touch *", lifetime: "always" });
    await store.addGrant({ tool: "exec_command", scope: "echo *", lifetime: "always" });
    let revoked = false;
    const coordinator = new AgentCoordinator({
      llmClient: clientCalling([`touch ${marker}`, "echo second"]),
      daemon,
      sessionsBaseDir: path.join(base, "sessions"),
      // Call 1's gates are snapshotted before call 2's PreToolUse hook runs: the revoke lands in between.
      hooks: {
        onPreToolUse: async ({ args }) => {
          if (!revoked && String(args.command).startsWith("echo")) {
            revoked = true;
            await store.revokeGrant(touchGrant.id);
          }
        },
      },
    });
    await coordinator.runTurn("go");
    assert.equal(revoked, true, "the revoke hook ran");
    assert.equal(fs.existsSync(marker), false, "the revoked command must not have been spawned");
    const [first, second] = toolResults(coordinator);
    assert.equal(first.status, "error");
    assert.equal(first.error.code, "PERMISSION_DENIED");
    assert.equal(second.stdout?.trim(), "second", "the command whose grant still stands runs");
  });

  it("denies when grants.json is corrupt", async () => {
    const marker = path.join(base, "ran-corrupt");
    await store.addGrant({ tool: "exec_command", scope: "touch *", lifetime: "always" });
    const grantsFile = path.join(base, "grants.json");
    fs.writeFileSync(grantsFile, "{");
    let prompts = 0;
    const coordinator = new AgentCoordinator({
      llmClient: clientCalling([`touch ${marker}`]),
      daemon,
      sessionsBaseDir: path.join(base, "sessions"),
      onApprovalRequired: async () => {
        prompts++;
        return false;
      },
    });
    await coordinator.runTurn("go");
    assert.equal(prompts, 1, "no standing grant can be trusted, so the user is asked");
    assert.equal(fs.existsSync(marker), false);
    assert.equal(toolResults(coordinator)[0].error.code, "PERMISSION_DENIED");
    assert.equal(fs.readFileSync(grantsFile, "utf8"), "{", "the file is not repaired");
  });

  it("refuses shell chaining through a prefix grant", async () => {
    const marker = path.join(base, "ran-chained");
    await store.addGrant({ tool: "exec_command", scope: "echo *", lifetime: "always" });
    let prompts = 0;
    const coordinator = new AgentCoordinator({
      llmClient: clientCalling([`echo hi; touch ${marker}`]),
      daemon,
      sessionsBaseDir: path.join(base, "sessions"),
      onApprovalRequired: async () => {
        prompts++;
        return false;
      },
    });
    await coordinator.runTurn("go");
    assert.equal(prompts, 1);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(toolResults(coordinator)[0].error.code, "PERMISSION_DENIED");
  });
});
