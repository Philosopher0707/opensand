import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { UniversalLLMClient } from "../src/llm-client.js";
import { AgentCoordinator } from "../src/coordinator.js";

describe("AgentCoordinator Integration", () => {
  let server: http.Server;
  let serverUrl: string;
  let tempDir: string;
  let daemon: LocalExecDaemon;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-coord-test-"));
    daemon = new LocalExecDaemon({
      stateDir: path.join(tempDir, "state"),
      heartbeatIntervalMs: 200,
    });
    await daemon.start();

    // Multi-turn mock server
    server = http.createServer((req, res) => {
      let bodyStr = "";
      req.on("data", (chunk) => {
        bodyStr += chunk;
      });

      req.on("end", () => {
        const payload = JSON.parse(bodyStr);
        const messages = payload.messages;
        const lastMsg = messages[messages.length - 1];

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (lastMsg.role === "tool") {
          // Model sees tool output and answers in natural language
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "Action completed successfully." } }],
            })}\n\n`
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } else if (lastMsg.content.includes("call-tool")) {
          // Model issues tool call
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    content: "Let me execute that.",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_mock_1",
                        type: "function",
                        function: {
                          name: "write_file",
                          arguments: JSON.stringify({
                            path: path.join(tempDir, "output.txt"),
                            content: "OpenSand Turn Loop Works!",
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          // Direct text response
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "Direct response from model." } }],
            })}\n\n`
          );
          res.write("data: [DONE]\n\n");
          res.end();
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await daemon.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("completes a single-turn natural language conversation", async () => {
    const client = new UniversalLLMClient({
      baseUrl: serverUrl,
      model: "gpt-4o",
    });

    const coordinator = new AgentCoordinator({
      llmClient: client,
      daemon,
      sessionsBaseDir: path.join(tempDir, "sessions"),
    });

    const res = await coordinator.runTurn("Hello");
    assert.equal(res, "Direct response from model.");
    assert.equal(coordinator.history.length, 3); // system, user, assistant
  });

  it("executes multi-turn tool loops autonomously", async () => {
    const client = new UniversalLLMClient({
      baseUrl: serverUrl,
      model: "gpt-4o",
    });

    const coordinator = new AgentCoordinator({
      llmClient: client,
      daemon,
      sessionsBaseDir: path.join(tempDir, "sessions"),
    });

    const finalAnswer = await coordinator.runTurn("Please call-tool to write file");
    assert.equal(finalAnswer, "Action completed successfully.");

    // Check that file was written to disk
    const fileContent = await fs.readFile(path.join(tempDir, "output.txt"), "utf-8");
    assert.equal(fileContent, "OpenSand Turn Loop Works!");

    // Verify history contains all steps:
    // 0: system
    // 1: user
    // 2: assistant (with tool_calls)
    // 3: tool (result)
    // 4: assistant (final natural language response)
    assert.equal(coordinator.history.length, 5);
    assert.equal(coordinator.history[2].role, "assistant");
    assert.ok(coordinator.history[2].tool_calls);
    assert.equal(coordinator.history[3].role, "tool");
    assert.equal(coordinator.history[4].role, "assistant");
    assert.equal(coordinator.history[4].content, "Action completed successfully.");

    // Verify transcript files were written
    const txtTranscript = await fs.readFile(
      path.join(coordinator.transcript.directory, "transcript.txt"),
      "utf-8"
    );
    assert.match(txtTranscript, /<user_query>/);
    assert.match(txtTranscript, /\[Tool call\]\nTool: write_file/);
    assert.match(txtTranscript, /\[Tool result\]/);
  });
});
