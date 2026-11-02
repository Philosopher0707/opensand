import { describe, it } from "node:test";
import * as assert from "node:assert";
import { HookDispatcher, LifecycleHooks } from "../src/hooks.js";
import { AgentCoordinator } from "../src/coordinator.js";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { UniversalLLMClient } from "../src/llm-client.js";

describe("Lifecycle Hooks System", () => {
  it("dispatches in-process lifecycle callbacks", async () => {
    const events: string[] = [];

    const hooks: LifecycleHooks = {
      onSessionStart: async ({ sessionId }) => {
        events.push(`start:${sessionId}`);
      },
      onPreToolUse: async ({ toolName }) => {
        events.push(`pre:${toolName}`);
        return true;
      },
      onPostToolUse: async ({ toolName }) => {
        events.push(`post:${toolName}`);
      },
      onPreCompact: async ({ turnCount }) => {
        events.push(`compact:${turnCount}`);
      },
      onStop: async ({ finalContent }) => {
        events.push(`stop:${finalContent}`);
      },
    };

    const dispatcher = new HookDispatcher(hooks);

    await dispatcher.dispatchSessionStart({ sessionId: "test-sess-1" });
    const preResult = await dispatcher.dispatchPreToolUse({
      sessionId: "test-sess-1",
      toolName: "exec_command",
      args: { command: "ls" },
    });
    assert.strictEqual(preResult.proceed, true);

    await dispatcher.dispatchPostToolUse({
      sessionId: "test-sess-1",
      toolName: "exec_command",
      args: { command: "ls" },
      result: { status: "success" },
    });

    await dispatcher.dispatchPreCompact({
      sessionId: "test-sess-1",
      turnCount: 3,
      tokensBefore: 1200,
    });

    await dispatcher.dispatchStop({
      sessionId: "test-sess-1",
      finalContent: "Completed task.",
    });

    assert.deepStrictEqual(events, [
      "start:test-sess-1",
      "pre:exec_command",
      "post:exec_command",
      "compact:3",
      "stop:Completed task.",
    ]);
  });

  it("blocks tool execution when PreToolUse returns proceed: false", async () => {
    const hooks: LifecycleHooks = {
      onPreToolUse: async ({ toolName }) => {
        if (toolName === "danger_tool") {
          return {
            proceed: false,
            reason: "Danger tool is forbidden by security policy",
          };
        }
        return true;
      },
    };

    const dispatcher = new HookDispatcher(hooks);

    const allowed = await dispatcher.dispatchPreToolUse({
      sessionId: "sess-2",
      toolName: "safe_tool",
      args: {},
    });
    assert.strictEqual(allowed.proceed, true);

    const blocked = await dispatcher.dispatchPreToolUse({
      sessionId: "sess-2",
      toolName: "danger_tool",
      args: {},
    });
    assert.strictEqual(blocked.proceed, false);
    assert.strictEqual(blocked.reason, "Danger tool is forbidden by security policy");
  });

  it("allows modifying arguments via PreToolUse", async () => {
    const hooks: LifecycleHooks = {
      onPreToolUse: async ({ toolName, args }) => {
        if (toolName === "query_db") {
          return {
            proceed: true,
            modifiedArgs: { ...args, sanitized: true },
          };
        }
        return true;
      },
    };

    const dispatcher = new HookDispatcher(hooks);
    const res = await dispatcher.dispatchPreToolUse({
      sessionId: "sess-3",
      toolName: "query_db",
      args: { query: "SELECT 1" },
    });

    assert.strictEqual(res.proceed, true);
    assert.deepStrictEqual(res.modifiedArgs, { query: "SELECT 1", sanitized: true });
  });
});
