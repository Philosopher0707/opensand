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

  it("persists conversation history across new coordinator instances with the same sessionId", async () => {
    const recordedPayloads: any[] = [];
    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      const payload = JSON.parse(init.body as string);
      recordedPayloads.push(payload);
      const encoder = new TextEncoder();
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Echo: " + payload.messages[payload.messages.length - 1].content } }] })}\n\n`,
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

    const persistentSessionId = "persistent-sess-001";
    const sessionsDir = path.join(tempDir, "sessions");

    // Turn 1 on coordinator instance 1
    const coordinator1 = new AgentCoordinator({
      sessionId: persistentSessionId,
      llmClient: client,
      daemon,
      sessionsBaseDir: sessionsDir,
    });
    const res1 = await coordinator1.runTurn("First turn message");
    assert.equal(res1, "Echo: First turn message");

    // Turn 2 on a completely new coordinator instance 2 (simulating process restart or session reload)
    const coordinator2 = new AgentCoordinator({
      sessionId: persistentSessionId,
      llmClient: client,
      daemon,
      sessionsBaseDir: sessionsDir,
    });
    const res2 = await coordinator2.runTurn("Second turn message");
    assert.equal(res2, "Echo: Second turn message");

    // Verify turn 2 LLM payload received turn 1 history!
    assert.equal(recordedPayloads.length, 2);
    const turn2Messages = recordedPayloads[1].messages;
    assert.equal(turn2Messages[0].role, "system");
    assert.equal(turn2Messages[1].role, "user");
    assert.equal(turn2Messages[1].content, "First turn message");
    assert.equal(turn2Messages[2].role, "assistant");
    assert.equal(turn2Messages[2].content, "Echo: First turn message");
    assert.equal(turn2Messages[3].role, "user");
    assert.equal(turn2Messages[3].content, "Second turn message");
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

  it("emits phase_started events (thinking, then executing) during a tool turn", async () => {
    const outputPath = path.join(tempDir, "output.txt");

    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      const payload = JSON.parse(init.body as string);
      const messages = payload.messages;
      const lastMsg = messages[messages.length - 1];
      const encoder = new TextEncoder();
      let chunks: string[] = [];

      if (lastMsg.role === "tool") {
        chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Done." } }] })}\n\n`,
          "data: [DONE]\n\n",
        ];
      } else {
        chunks = [
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  content: "I'll write the file.",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_phase_1",
                      type: "function",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({
                          path: outputPath,
                          content: "phase test",
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

    const phases: Array<{ phase: string; iteration: number; maxIterations: number }> = [];
    const coordinator = new AgentCoordinator({
      llmClient: client,
      daemon,
      sessionsBaseDir: path.join(tempDir, "sessions"),
      onEvent: (event) => {
        if (event.type === "phase_started") {
          phases.push({
            phase: event.phase,
            iteration: event.iteration,
            maxIterations: event.maxIterations,
          });
        }
      },
    });

    const finalAnswer = await coordinator.runTurn("Write the file");
    assert.equal(finalAnswer, "Done.");
    // Iteration 1: thinking then executing; iteration 2: thinking only.
    assert.deepEqual(phases[0], { phase: "thinking", iteration: 1, maxIterations: 150 });
    assert.deepEqual(phases[1], { phase: "executing", iteration: 1, maxIterations: 150 });
    assert.deepEqual(phases[2], { phase: "thinking", iteration: 2, maxIterations: 150 });
    assert.equal(phases.length, 3);
  });

  it("enforces allowedTools whitelist policy on agent tool execution", async () => {
    let callCount = 0;
    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      callCount++;
      const encoder = new TextEncoder();
      const payload = JSON.parse(init.body as string);

      // Verify that tool definitions sent to LLM only contain allowed tools
      assert.ok(payload.tools.every((t: any) => t.function.name === "read_file"));

      let chunks: string[] = [];
      if (callCount === 1) {
        // Model attempts to call an unauthorized tool (e.g. exec_command)
        chunks = [
          `data: ${JSON.stringify({
            choices: [{
              delta: {
                content: "Attempting command.",
                tool_calls: [{
                  index: 0,
                  id: "call_unauth",
                  type: "function",
                  function: { name: "exec_command", arguments: '{"command":"ls"}' }
                }]
              }
            }]
          })}\n\n`,
          "data: [DONE]\n\n"
        ];
      } else {
        chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Understood, command was blocked." } }] })}\n\n`,
          "data: [DONE]\n\n"
        ];
      }

      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: mockFetch as any,
    });

    const coordinator = new AgentCoordinator({
      llmClient: client,
      daemon,
      allowedTools: ["read_file"],
      sessionsBaseDir: path.join(tempDir, "sessions"),
    });

    const answer = await coordinator.runTurn("Run ls");
    assert.equal(answer, "Understood, command was blocked.");

    // Check that tool message in history recorded UNAUTHORIZED_TOOL
    const toolMsg = coordinator.history.find(m => m.role === "tool");
    assert.ok(toolMsg);
    assert.match(toolMsg.content || "", /UNAUTHORIZED_TOOL/);
  });

  it("strictly constrains exposed and active tool definitions to allowedTools whitelist", async () => {
    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
    });

    // 1. Constrained to specific whitelist
    const coordinator1 = new AgentCoordinator({
      llmClient: client,
      daemon,
      allowedTools: ["read_file", "write_file"],
      sessionsBaseDir: path.join(tempDir, "sessions"),
    });

    const activeTools1 = coordinator1.getActiveToolDefinitions("Perform git and file tasks");
    assert.strictEqual(activeTools1.length, 2);
    assert.deepStrictEqual(activeTools1.map((t) => t.function.name).sort(), ["read_file", "write_file"]);

    // 2. Empty allowedTools array strictly exposes 0 tools
    const coordinatorEmpty = new AgentCoordinator({
      llmClient: client,
      daemon,
      allowedTools: [],
      sessionsBaseDir: path.join(tempDir, "sessions"),
    });

    const activeToolsEmpty = coordinatorEmpty.getActiveToolDefinitions("Any prompt");
    assert.strictEqual(activeToolsEmpty.length, 0);

    // 3. Turn execution with allowedTools: [] intercepts and blocks any tool call
    let callCount = 0;
    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      callCount++;
      const encoder = new TextEncoder();
      const payload = JSON.parse(init.body as string);
      // Verify tool definitions sent to LLM is empty array
      assert.strictEqual(payload.tools?.length ?? 0, 0);

      let chunks: string[] = [];
      if (callCount === 1) {
        chunks = [
          `data: ${JSON.stringify({
            choices: [{
              delta: {
                content: "Calling blocked tool",
                tool_calls: [{
                  index: 0,
                  id: "call_blocked",
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: "file.txt" }) }
                }]
              }
            }]
          })}\n\n`,
          "data: [DONE]\n\n"
        ];
      } else {
        chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Acknowledged." } }] })}\n\n`,
          "data: [DONE]\n\n"
        ];
      }

      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const emptyClient = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: mockFetch as any,
    });

    const emptyCoordinator = new AgentCoordinator({
      llmClient: emptyClient,
      daemon,
      allowedTools: [],
      sessionsBaseDir: path.join(tempDir, "sessions"),
    });

    const res = await emptyCoordinator.runTurn("Read file");
    assert.strictEqual(res, "Acknowledged.");
    const blockedMsg = emptyCoordinator.history.find((m) => m.role === "tool");
    assert.ok(blockedMsg);
    assert.match(blockedMsg.content || "", /UNAUTHORIZED_TOOL/);
  });

  it("answers ephemeral side-questions via askSideQuestion without mutating session history (BTW prompt parity)", async () => {
    let callCount = 0;
    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      callCount++;
      const encoder = new TextEncoder();
      const content = callCount === 1 ? "We are working on Project Sand." : "You are discussing Project Sand.";
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
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

    // 1. Initial turn
    const turnRes = await coordinator.runTurn("Hello, let us start Project Sand.");
    assert.equal(turnRes, "We are working on Project Sand.");
    const historyLengthBefore = coordinator.history.length;
    assert.equal(historyLengthBefore, 3); // system, user, assistant

    // 2. Ask ephemeral side question
    const btwAnswer = await coordinator.askSideQuestion("What project did I mention?");
    assert.equal(btwAnswer, "You are discussing Project Sand.");

    // 3. Verify history is untouched
    assert.equal(coordinator.history.length, historyLengthBefore);
    assert.equal(coordinator.history[coordinator.history.length - 1].content, "We are working on Project Sand.");
  });

  it("rolls back conversation turns cleanly via rollbackTurns (RollBackGrokBotConversation parity)", async () => {
    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      const payload = JSON.parse(init.body as string);
      const userMsg = payload.messages.filter((m: any) => m.role === "user").pop();
      const encoder = new TextEncoder();
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: `Answer for ${userMsg.content}` } }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
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

    await coordinator.runTurn("Turn 1");
    await coordinator.runTurn("Turn 2");
    assert.equal(coordinator.history.length, 5); // system, u1, a1, u2, a2

    // Rollback 1 turn (undo Turn 2)
    const rb1 = await coordinator.rollbackTurns(1);
    assert.equal(rb1.removedMessages, 2);
    assert.equal(coordinator.history.length, 3); // system, u1, a1
    assert.equal(coordinator.history[coordinator.history.length - 1].content, "Answer for Turn 1");

    // Rollback 1 more turn (undo Turn 1)
    const rb2 = await coordinator.rollbackTurns(1);
    assert.equal(rb2.removedMessages, 2);
    assert.equal(coordinator.history.length, 1); // system only
  });

  it("compacts older conversational history while preserving system instructions and recent turns", async () => {
    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      const payload = JSON.parse(init.body as string);
      const userMsg = payload.messages.filter((m: any) => m.role === "user").pop();
      const encoder = new TextEncoder();
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: `Response for ${userMsg.content}` } }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
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

    await coordinator.runTurn("Turn 1: Setup project structure and configure TypeScript, linting, packaging configs, and git hooks with continuous integration scripts.");
    await coordinator.runTurn("Turn 2: Install dependencies, configure dependencies resolution, lockfiles, and peer dependency overrides for the workspace monorepo.");
    await coordinator.runTurn("Turn 3: Write primary feature");
    await coordinator.runTurn("Turn 4: Run unit test suite");

    const tokensBefore = coordinator.estimateTokens();
    assert.ok(tokensBefore > 0);
    assert.equal(coordinator.history.length, 9); // 1 system + 4*(user+assistant) = 9

    // Compact history keeping the 2 most recent turns (Turn 3 and 4)
    const compactRes = await coordinator.compactHistory({ keepRecentTurns: 2 });
    // console.log("Tokens before:", compactRes.originalTokens, "after:", compactRes.compactedTokens);
    assert.equal(compactRes.compactedTurnCount, 2);

    // History now has: system (original), system (summary), Turn 3 (user, asst), Turn 4 (user, asst) = 6
    assert.equal(coordinator.history.length, 6);
    assert.equal(coordinator.history[0].role, "system");
    assert.equal(coordinator.history[1].role, "system");
    assert.ok(coordinator.history[1].content?.includes("<historical_context_summary>"));
    assert.ok(coordinator.history[1].content?.includes("Turn 1"));

    // Most recent turn is preserved
    assert.equal(coordinator.history[coordinator.history.length - 2].content, "Turn 4: Run unit test suite");
  });

  it("bounds excessive tool output to protect the context window", async () => {
    let capturedToolMessageContent: any = undefined;

    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      const payload = JSON.parse(init.body as string);
      const messages = payload.messages;
      const lastMsg = messages[messages.length - 1];
      const encoder = new TextEncoder();

      let chunks: string[] = [];

      if (lastMsg.role === "tool") {
        capturedToolMessageContent = lastMsg.content;
        chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Parsed huge output safely." } }] })}\n\n`,
          "data: [DONE]\n\n",
        ];
      } else {
        chunks = [
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  content: "Generating large output.",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_huge_1",
                      type: "function",
                      function: {
                        name: "exec_command",
                        arguments: JSON.stringify({
                          command: "node -e \"process.stdout.write('X'.repeat(30000))\"",
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
      onApprovalRequired: async () => true,
    });

    const reply = await coordinator.runTurn("Produce huge output");
    assert.equal(reply, "Parsed huge output safely.");
    assert.ok(typeof capturedToolMessageContent === "string");
    // Bounded tool output must contain the truncation notice and be bounded
    assert.ok(capturedToolMessageContent.includes("Tool output truncated:"));
    assert.ok(capturedToolMessageContent.includes("characters omitted"));
    assert.ok(capturedToolMessageContent.length < 20000);
  });

  it("automatically compacts context when maxContextTokens threshold is crossed", async () => {
    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      const payload = JSON.parse(init.body as string);
      const userMsg = payload.messages.filter((m: any) => m.role === "user").pop();
      const encoder = new TextEncoder();
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: `Answer to ${userMsg.content}` } }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: mockFetch as any,
    });

    // Set a very low maxContextTokens so auto-compaction is triggered
    const coordinator = new AgentCoordinator({
      llmClient: client,
      daemon,
      sessionsBaseDir: path.join(tempDir, "sessions"),
      maxContextTokens: 100,
    });

    await coordinator.runTurn("Turn 1: Comprehensive architectural design document for asynchronous microservices with distributed transaction log.");
    await coordinator.runTurn("Turn 2: Database schema specifications, index optimization strategy, and write-ahead log failover mechanisms.");
    await coordinator.runTurn("Turn 3: Service discovery, RPC retry contracts, and circuit breaker rate limiting protocols.");
    await coordinator.runTurn("Turn 4: Test suite execution and verification report.");

    // Since maxContextTokens was set to 100, auto-compaction must have triggered
    const summaryMsg = coordinator.history.find(
      (m) => m.role === "system" && m.content?.includes("<historical_context_summary>")
    );
    assert.ok(summaryMsg !== undefined, "Expected historical context summary from auto-compaction");
  });

  it("scopes tools according to toolScopeMode", async () => {
    let capturedToolCount = 0;

    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      const payload = JSON.parse(init.body as string);
      capturedToolCount = payload.tools?.length ?? 0;
      const encoder = new TextEncoder();
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Understood." } }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: mockFetch as any,
    });

    // In "core" mode, only core coding tools should be sent
    const coordinator = new AgentCoordinator({
      llmClient: client,
      daemon,
      sessionsBaseDir: path.join(tempDir, "sessions"),
      toolScopeMode: "core",
    });

    await coordinator.runTurn("Hello");
    // Core mode should limit tools to the essential set (< 20), whereas daemon total is > 30
    assert.ok(capturedToolCount > 0 && capturedToolCount <= 15);
  });
});

describe("AgentCoordinator Policy Boundary", () => {
  let tempDir: string;
  let daemon: LocalExecDaemon;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-coord-policy-"));
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

  function makeToolClient(toolName: string, toolArgs: Record<string, unknown>) {
    return new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: (async (_url: any, init: any): Promise<Response> => {
        const payload = JSON.parse(init.body as string);
        const messages = payload.messages;
        const lastMsg = messages[messages.length - 1];
        const encoder = new TextEncoder();
        let chunks: string[] = [];
        if (lastMsg.role === "tool") {
          chunks = [
            'data: ' + JSON.stringify({ choices: [{ delta: { content: "Done." } }] }) + '\n\n',
            "data: [DONE]\n\n",
          ];
        } else {
          chunks = [
            'data: ' + JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_policy_1",
                        type: "function",
                        function: { name: toolName, arguments: JSON.stringify(toolArgs) },
                      },
                    ],
                  },
                },
              ],
            }) + '\n\n',
            "data: [DONE]\n\n",
          ];
        }
        const stream = new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }) as any,
    });
  }

  it("policy DENY hard-blocks read_file on /etc/shadow in the turn loop", async () => {
    const client = makeToolClient("read_file", { path: "/etc/shadow" });
    const coordinator = new AgentCoordinator({
      llmClient: client,
      daemon,
      sessionsBaseDir: path.join(tempDir, "sessions-deny"),
    });

    const final = await coordinator.runTurn("read /etc/shadow");
    assert.equal(final, "Done.");
    const toolMsg = coordinator.history.find((m) => m.role === "tool");
    assert.ok(toolMsg);
    const result = JSON.parse(String(toolMsg.content));
    assert.equal(result.status, "error");
    assert.equal(result.error.code, "POLICY_DENIED");
    assert.ok(result.error.message.includes("Policy Boundary Violation"));
    assert.equal(result.error.reason, "policy");
  });

  it("policy REQUIRE_APPROVAL prompts the user for write_file (custom rule)", async () => {
    const target = path.join(tempDir, "approved-out.txt");
    daemon.policy.setRule({
      id: "rule_approve_tmp_writes",
      name: "Approve temp writes",
      enabled: true,
      action: "REQUIRE_APPROVAL",
      conditions: { tools: ["write_file"], pathsPrefix: [tempDir] },
    });
    const client = makeToolClient("write_file", { path: target, content: "hello" });
    let prompted = false;
    const coordinator = new AgentCoordinator({
      llmClient: client,
      daemon,
      sessionsBaseDir: path.join(tempDir, "sessions-approve"),
      onApprovalRequired: async () => {
        prompted = true;
        return false;
      },
    });

    await coordinator.runTurn("write the file");
    assert.equal(prompted, true, "approval was requested");
    const toolMsg = coordinator.history.find((m) => m.role === "tool");
    const result = JSON.parse(String(toolMsg?.content));
    assert.equal(result.error.code, "PERMISSION_DENIED");
    assert.equal(result.error.reason, "user_rejected");

    const exists = await fs.stat(target).then(() => true).catch(() => false);
    assert.equal(exists, false);

    daemon.policy.deleteRule("rule_approve_tmp_writes");
  });

  it("policy ALLOW for list_directory runs without prompting", async () => {
    const client = makeToolClient("list_directory", { path: tempDir });
    let prompted = false;
    const coordinator = new AgentCoordinator({
      llmClient: client,
      daemon,
      sessionsBaseDir: path.join(tempDir, "sessions-allow"),
      onApprovalRequired: async () => {
        prompted = true;
        return true;
      },
    });

    await coordinator.runTurn("list the dir");
    assert.equal(prompted, false);
    const toolMsg = coordinator.history.find((m) => m.role === "tool");
    const result = JSON.parse(String(toolMsg?.content));
    assert.ok(Array.isArray(result.entries));
  });
});


describe("Retention (planRetention / pruneSessions)", () => {
  it("keeps the N most recent and removes older ones", async () => {
    const { mkdtemp, writeFile, mkdir, readdir } = await import("node:fs/promises");
    const { default: os } = await import("node:os");
    const { default: path } = await import("node:path");
    const { planRetention, pruneSessions, evaluateRetention } = await import("../src/transcript-manager.js");

    const now = Date.now();
    const mk = (id: string, ageDays: number) => ({ sessionId: id, dir: `/tmp/${id}`, mtimeMs: now - ageDays * 24 * 3600 * 1000, sizeBytes: 100 });

    const candidates = [mk("s1", 1), mk("s2", 5), mk("s3", 100), mk("s4", 200), mk("s5", 300)];
    const { removed, kept } = planRetention(candidates, { maxSessions: 2, maxAgeDays: 90, keepRecentDays: 7 }, now);

    // s3..s5 are already >90 days old; s1/s2 kept (count + recent)
    assert.ok(kept.some((c: any) => c.sessionId === "s1"));
    assert.ok(kept.some((c: any) => c.sessionId === "s2"));
    assert.ok(removed.some((c: any) => c.sessionId === "s3"));
    assert.ok(removed.some((c: any) => c.sessionId === "s5"));
  });

  it("never removes sessions inside the keep-recent window even if over count", async () => {
    const { planRetention } = await import("../src/transcript-manager.js");
    const now = Date.now();
    const mk = (id: string, ageDays: number) => ({ sessionId: id, dir: `/tmp/${id}`, mtimeMs: now - ageDays * 24 * 3600 * 1000, sizeBytes: 100 });
    const candidates = [mk("recent1", 1), mk("recent2", 2), mk("old", 400)];
    const { removed, kept } = planRetention(candidates, { maxSessions: 1, maxAgeDays: 90, keepRecentDays: 7 }, now);
    // recent2 is over maxSessions=1 but within keep window, so kept
    assert.ok(kept.some((c: any) => c.sessionId === "recent1"));
    assert.ok(kept.some((c: any) => c.sessionId === "recent2"));
    assert.ok(removed.some((c: any) => c.sessionId === "old"));
  });

  it("pruneSessions deletes only over-policy dirs on disk", async () => {
    const { mkdtemp, mkdir, writeFile, readdir } = await import("node:fs/promises");
    const { default: os } = await import("node:os");
    const { default: path } = await import("node:path");
    const { pruneSessions } = await import("../src/transcript-manager.js");

    const base = await mkdtemp(path.join(os.tmpdir(), "opensand-retention-"));
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const dir = path.join(base, `sess_${i}`);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "transcript.jsonl"), "x\n", "utf-8");
      const ageMs = (i < 2 ? 1 : 200) * 24 * 3600 * 1000;
      const { utimes } = await import("node:fs/promises");
      await utimes(dir, new Date(now - ageMs), new Date(now - ageMs));
    }
    const { removed } = await pruneSessions(base, { maxSessions: 2, maxAgeDays: 90, keepRecentDays: 7 }, now);
    const remaining = await readdir(base);
    assert.strictEqual(removed.length, 3);
    assert.strictEqual(remaining.length, 2);
    await import("node:fs/promises").then((fs2) => fs2.rm(base, { recursive: true, force: true }));
  });
});
