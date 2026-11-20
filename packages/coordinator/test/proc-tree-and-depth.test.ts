import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { killProcessTree } from "../src/proc-tree.js";
import { UniversalLLMClient } from "../src/llm-client.js";
import { AgentCoordinator } from "../src/coordinator.js";
import { registerOrchestratorTools } from "../src/orchestrator-tools.js";

describe("process cleanup and delegation bound", () => {
  it("kills a child and its descendants on POSIX", async () => {
    if (process.platform === "win32") return;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-proctree-"));
    const pidFile = path.join(dir, "grandchild.pid");
    const child = spawn("/bin/sh", ["-c", `sleep 60 & echo $! > "${pidFile}"; sleep 60`], {
      detached: true,
      stdio: "ignore",
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const grandchild = Number((await fs.readFile(pidFile, "utf8")).trim());
      assert.ok(grandchild > 1);
      killProcessTree(child);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.throws(() => process.kill(grandchild, 0), "grandchild must be gone after group kill");
    } finally {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a fourth delegation level without running the child", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-depth-"));
    const daemon = new LocalExecDaemon({
      stateDir: path.join(tempDir, "state"),
      heartbeatIntervalMs: 200,
    });
    await daemon.start();
    registerOrchestratorTools({ daemon, sessionsBaseDir: path.join(tempDir, "sessions") });

    let turn = 0;
    const mockFetch = async (_url: unknown, init: any): Promise<Response> => {
      const encoder = new TextEncoder();
      const chunks = turn++ === 0
        ? [JSON.stringify({
            choices: [{ delta: { tool_calls: [{
              index: 0,
              id: "call_delegate",
              type: "function",
              function: {
                name: "delegate_to_agent",
                arguments: JSON.stringify({ agent_id_or_name: "missing-agent", task: "do work" }),
              },
            }] } }],
          })]
        : ["Delegate was refused."];
      const sse = chunks.map((c) => `data: ${c}\n\n`).concat("data: [DONE]\n\n");
      return new Response(new ReadableStream({
        start(controller) {
          for (const chunk of sse) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const executed: string[] = [];
    const original = daemon.executeTool.bind(daemon);
    (daemon as any).executeTool = async (name: string, args: Record<string, any>, context?: unknown) => {
      executed.push(name);
      return original(name, args, context as any);
    };

    try {
      const coordinator = new AgentCoordinator({
        llmClient: new UniversalLLMClient({
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o",
          fetch: mockFetch as any,
        }),
        daemon,
        sessionsBaseDir: path.join(tempDir, "sessions"),
        subagentDepth: 3,
      });
      await coordinator.runTurn("delegate this");
      assert.ok(!executed.includes("delegate_to_agent"), "depth-4 delegation must not reach the tool");
      assert.ok(
        coordinator.history.some((m) => JSON.stringify(m).includes("DELEGATION_DEPTH_LIMIT")),
        "the refusal must be materialized in the transcript",
      );
    } finally {
      await daemon.stop();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
