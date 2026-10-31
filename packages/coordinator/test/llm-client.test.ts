import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UniversalLLMClient } from "../src/llm-client.js";
import { ChatMessage } from "../src/types.js";

describe("UniversalLLMClient", () => {
  it("streams chat completions from OpenAI-compatible endpoint", async () => {
    let capturedBody: any = null;

    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      capturedBody = JSON.parse(init.body as string);
      const encoder = new TextEncoder();

      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "world!" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ];

      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) {
            controller.enqueue(encoder.encode(c));
          }
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
      apiKey: "sk-test",
      fetch: mockFetch as any,
    });

    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const { stream, getConsolidated } = await client.streamCompletion(messages);

    const deltas: string[] = [];
    for await (const chunk of stream) {
      if (chunk.content) deltas.push(chunk.content);
    }

    assert.deepEqual(deltas, ["Hello ", "world!"]);
    const consolidated = getConsolidated();
    assert.equal(consolidated.role, "assistant");
    assert.equal(consolidated.content, "Hello world!");
    assert.equal(capturedBody.model, "gpt-4o");
    assert.equal(capturedBody.stream, true);
  });

  it("handles 401 unauthorized with actionable diagnostics", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: { message: "You didn't provide an API key." } }), {
        status: 401,
        statusText: "Unauthorized",
      });
    };

    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: mockFetch as any,
    });

    await assert.rejects(
      async () => {
        await client.streamCompletion([{ role: "user", content: "hey" }]);
      },
      (err: Error) => {
        assert.ok(err.message.includes("401 Unauthorized"));
        assert.ok(err.message.includes("Provide an API key"));
        return true;
      }
    );
  });

  it("handles ECONNREFUSED with local model instructions", async () => {
    const mockFetch = async (): Promise<Response> => {
      const err: any = new Error("connect ECONNREFUSED 127.0.0.1:11434");
      err.code = "ECONNREFUSED";
      throw err;
    };

    const client = new UniversalLLMClient({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      fetch: mockFetch as any,
    });

    await assert.rejects(
      async () => {
        await client.streamCompletion([{ role: "user", content: "test" }]);
      },
      (err: Error) => {
        assert.ok(err.message.includes("Connection refused"));
        assert.ok(err.message.includes("ollama serve"));
        return true;
      }
    );
  });

  it("handles 404 Not Found with model lookup hint", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: { message: "Model not found" } }), {
        status: 404,
        statusText: "Not Found",
      });
    };

    const client = new UniversalLLMClient({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "unknown-model",
      fetch: mockFetch as any,
    });

    await assert.rejects(
      async () => {
        await client.streamCompletion([{ role: "user", content: "test" }]);
      },
      (err: Error) => {
        assert.ok(err.message.includes("404 Not Found"));
        assert.ok(err.message.includes("Check available models"));
        return true;
      }
    );
  });

  it("aborts stream early when AbortSignal triggers", async () => {
    const encoder = new TextEncoder();
    const abortController = new AbortController();

    const mockFetch = async (): Promise<Response> => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "part1" } }] })}\n\n`)
          );
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "part2" } }] })}\n\n`)
          );
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const client = new UniversalLLMClient({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      fetch: mockFetch as any,
    });

    const { stream } = await client.streamCompletion(
      [{ role: "user", content: "test" }],
      undefined,
      abortController.signal
    );

    const chunks: string[] = [];
    for await (const chunk of stream) {
      if (chunk.content) {
        chunks.push(chunk.content);
        abortController.abort();
      }
    }

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "part1");
  });
});
