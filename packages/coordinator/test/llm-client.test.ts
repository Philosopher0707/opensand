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
});
