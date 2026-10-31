import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { UniversalLLMClient } from "../src/llm-client.js";
import { AgentCoordinator } from "../src/coordinator.js";

describe("AgentCoordinator Integration", () => {
  let tempDir: string;
  let daemon: LocalExecDaemon;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-coord-test-"));
    daemon = new LocalExecDaemon({
      stateDir: path.join(tempDir, "state"),
      heartbeatIntervalMs: 200,
    });
    await daemon.start();
  });

  after(async () => {
    await daemon.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("completes a single-turn natural language conversation", async () => {
    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      const encoder = new TextEncoder();
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Direct response from model." } }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: mockFetch as any,
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
    const outputPath = path.join(tempDir, "output.txt");

    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      const payload = JSON.parse(init.body as string);
      const messages = payload.messages;
      const lastMsg = messages[messages.length - 1];
      const encoder = new TextEncoder();

      let chunks: string[] = [];

      if (lastMsg.role === "tool") {
        // Model sees tool output and answers in natural language
        chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Action completed successfully." } }] })}\n\n`,
          "data: [DONE]\n\n",
        ];
      } else {
        // Model issues tool call
        chunks = [
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
                          path: outputPath,
                          content: "OpenSand Turn Loop Works!",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
          "data: [DONE]\n\n",
        ];
      }

      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: mockFetch as any,
    });

    const coordinator = new AgentCoordinator({
      llmClient: client,
      daemon,
      sessionsBaseDir: path.join(tempDir, "sessions"),
    });

    const finalAnswer = await coordinator.runTurn("Please write output file");
    assert.equal(finalAnswer, "Action completed successfully.");

    // Check that file was written to disk by daemon
    const fileContent = await fs.readFile(outputPath, "utf-8");
    assert.equal(fileContent, "OpenSand Turn Loop Works!");

    // Verify history contains all 5 steps
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
