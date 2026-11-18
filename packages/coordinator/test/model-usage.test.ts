import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EventLogReader } from "@opensand/shared";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { UniversalLLMClient } from "../src/llm-client.js";
import { AgentCoordinator } from "../src/coordinator.js";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("model call usage", () => {
  it("records the exact numbers a provider reports", async () => {
    const client = new UniversalLLMClient({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openrouter/test-model",
      fetch: (async () =>
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 567, cost: 0.0042 } })}\n\n`,
          "data: [DONE]\n\n",
        ])) as any,
    });

    const { stream, getUsage } = await client.streamCompletion([{ role: "user", content: "hi" }]);
    for await (const _ of stream) {
      // drain
    }

    assert.deepEqual(getUsage(), {
      model: "openrouter/test-model",
      inputTokens: 1234,
      outputTokens: 567,
      costUsd: 0.0042,
    });
  });

  it("records null, not zero, when the provider reports no usage", async () => {
    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: (async () =>
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`,
          "data: [DONE]\n\n",
        ])) as any,
    });

    const { stream, getUsage } = await client.streamCompletion([{ role: "user", content: "hi" }]);
    for await (const _ of stream) {
      // drain
    }

    assert.deepEqual(getUsage(), {
      model: "gpt-4o",
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  });

  it("records Anthropic input and output tokens from the stream events", async () => {
    const client = new UniversalLLMClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-test",
      fetch: (async () =>
        sseResponse([
          `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 1 } } })}\n\n`,
          `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } })}\n\n`,
          `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 9 } })}\n\n`,
        ])) as any,
    });

    const { stream, getUsage } = await client.streamCompletion([{ role: "user", content: "hi" }]);
    for await (const _ of stream) {
      // drain
    }

    assert.deepEqual(getUsage(), {
      model: "claude-test",
      inputTokens: 11,
      outputTokens: 9,
      costUsd: null,
    });
  });
});

describe("model.completion records usage through the real turn loop", () => {
  let tempDir: string;
  let daemon: LocalExecDaemon;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-usage-test-"));
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

  it("writes the provider's usage onto the model.completion event", async () => {
    const client = new UniversalLLMClient({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openrouter/test-model",
      fetch: (async () =>
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Recorded." } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } })}\n\n`,
          "data: [DONE]\n\n",
        ])) as any,
    });

    const sessionsDir = path.join(tempDir, "sessions");
    const coordinator = new AgentCoordinator({
      sessionId: "usage-session-001",
      llmClient: client,
      daemon,
      sessionsBaseDir: sessionsDir,
    });

    assert.equal(await coordinator.runTurn("Hello"), "Recorded.");

    const events = await new EventLogReader(path.join(sessionsDir, "usage-session-001")).readAll();
    const completions = events.filter((event) => event.kind === "model.completion");
    assert.equal(completions.length, 1);
    assert.deepEqual(completions[0].data.usage, {
      model: "openrouter/test-model",
      inputTokens: 42,
      outputTokens: 7,
      costUsd: null,
    });
  });
});
