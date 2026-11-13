import * as http from "node:http";
import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { AgentCoordinator } from "../src/coordinator.js";
import { UniversalLLMClient } from "../src/llm-client.js";

/**
 * Subagent sandbox boundary. A coordinator running as a subagent
 * (subagentDepth > 0) must have its commands contained to its workspace:
 * writing outside is refused and the file never appears on disk.
 *
 * The test root lives in /var/tmp on purpose: it is outside the OS temp dir
 * (which the sandbox allows writes to) and outside /tmp (which Linux bubblewrap
 * masks with an ephemeral tmpfs), so "outside" means the same thing on macOS
 * and Linux.
 */

function containmentAvailable(): boolean {
  if (process.platform === "darwin") return fs.existsSync("/usr/bin/sandbox-exec");
  if (process.platform === "linux") {
    return fs.existsSync("/usr/bin/bwrap") || fs.existsSync("/bin/bwrap");
  }
  return false;
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function toolCallChunks(commands: string[]): unknown {
  return {
    choices: [
      {
        delta: {
          tool_calls: commands.map((command, index) => ({
            index,
            id: `call_${index}`,
            function: { name: "exec_command", arguments: JSON.stringify({ command }) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function contentChunk(text: string): unknown {
  return { choices: [{ delta: { content: text }, finish_reason: "stop" }] };
}

test(
  "a subagent's commands are contained to its workspace",
  { skip: containmentAvailable() ? false : "no OS sandbox containment available on this platform" },
  async () => {
    const root = path.join("/var/tmp", `opensand-p4d-containment-${randomUUID()}`);
    const workspaceDir = path.join(root, "workspace");
    const outsideDir = path.join(root, "outside-canary");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "canary.txt"), "untouched\n", "utf-8");

    const escapedFile = path.join(outsideDir, "escaped.txt");
    const escapeCommand = `echo hack > "${escapedFile}"`;
    const insideCommand = "echo inside > inside.txt";

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let messages: any[] = [];
        try {
          messages = JSON.parse(body || "{}").messages ?? [];
        } catch {
          messages = [];
        }
        const hasToolResult = messages.some((m) => m.role === "tool");
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (hasToolResult) {
          res.end(sse(contentChunk("Subagent done.")) + "data: [DONE]\n\n");
        } else {
          res.end(
            sse(toolCallChunks([escapeCommand, insideCommand])) + "data: [DONE]\n\n"
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-p4d-containment-state-"));
    const daemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "state") });
    await daemon.start();
    await daemon.state.writePermissionGates({ computerUseAllowed: true });

    try {
      const results: any[] = [];
      const coordinator = new AgentCoordinator({
        llmClient: new UniversalLLMClient({
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "mock-subagent-model",
          apiKey: "none",
        }),
        daemon,
        sessionId: "subagent_containment_test",
        sessionsBaseDir: path.join(tmpDir, "sessions"),
        workspaceDir,
        // Depth > 0 marks this coordinator as a subagent: it inherits the
        // workspace-write sandbox boundary.
        subagentDepth: 1,
        onEvent: (event: any) => {
          if (event?.type === "tool_call_completed") results.push(event.result);
        },
      });

      await coordinator.runTurn("Try to write outside the workspace, then inside it.");

      assert.strictEqual(results.length, 2, "both exec_command calls must have run");

      const escape = results[0];
      assert.strictEqual(escape.status, "ok", `escape call failed to run: ${JSON.stringify(escape)}`);
      assert.notStrictEqual(
        escape.output?.exitCode,
        0,
        `writing outside the workspace must fail, stderr: ${escape.output?.stderr}`
      );
      assert.strictEqual(
        fs.existsSync(escapedFile),
        false,
        "no file may be created outside the subagent workspace"
      );
      assert.strictEqual(
        fs.readFileSync(path.join(outsideDir, "canary.txt"), "utf-8"),
        "untouched\n"
      );

      const inside = results[1];
      assert.strictEqual(inside.status, "ok", `inside call failed to run: ${JSON.stringify(inside)}`);
      assert.strictEqual(
        inside.output?.exitCode,
        0,
        `writing inside the workspace must succeed, stderr: ${inside.output?.stderr}`
      );
      assert.strictEqual(
        fs.readFileSync(path.join(workspaceDir, "inside.txt"), "utf-8").trim(),
        "inside"
      );
    } finally {
      await daemon.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
