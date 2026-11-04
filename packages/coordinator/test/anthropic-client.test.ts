import { describe, it } from "node:test";
import * as assert from "node:assert";
import { AnthropicClient, ANTHROPIC_KNOWN_MODELS } from "../src/anthropic-client.js";
import { isAnthropicProvider, resolveAnthropicEndpoint } from "../src/anthropic-adapter.js";

describe("Anthropic API Module (AnthropicClient)", () => {
  it("initializes with sane defaults and resolves proper endpoint", () => {
    const client = new AnthropicClient({ apiKey: "sk-ant-test" });
    assert.strictEqual(client.model, "claude-3-7-sonnet-20250219");
    assert.strictEqual(client.resolveEndpoint(), "https://api.anthropic.com/v1/messages");
  });

  it("lists known Claude models with context windows and capabilities", () => {
    const client = new AnthropicClient();
    const models = client.listModels();
    assert.ok(models.length >= 4);

    const sonnet37 = models.find((m) => m.id === "claude-3-7-sonnet-20250219");
    assert.ok(sonnet37);
    assert.strictEqual(sonnet37.context_length, 200000);
    assert.strictEqual(sonnet37.supports_thinking, true);
    assert.strictEqual(sonnet37.supports_prompt_caching, true);
  });

  it("isAnthropicProvider correctly separates direct Anthropic from OpenRouter proxies", () => {
    // Direct Anthropic endpoints
    assert.strictEqual(isAnthropicProvider({ baseUrl: "https://api.anthropic.com/v1", model: "claude-3-5-sonnet" }), true);
    assert.strictEqual(isAnthropicProvider({ baseUrl: "https://api.anthropic.com/v1/messages", model: "claude-3-7" }), true);
    assert.strictEqual(isAnthropicProvider({ baseUrl: "http://custom-proxy/v1", model: "claude-3-5", provider: "anthropic" }), true);

    // OpenRouter endpoints routing Claude should NOT use direct Anthropic message payload format
    assert.strictEqual(
      isAnthropicProvider({ baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-3.5-sonnet" }),
      false
    );
    assert.strictEqual(
      isAnthropicProvider({ baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-3.5-sonnet", provider: "openrouter" }),
      false
    );
    assert.strictEqual(
      isAnthropicProvider({ baseUrl: "http://localhost:11434/v1/chat/completions", model: "llama3.1", provider: "openai" }),
      false
    );
  });

  it("streams messages and parses SSE responses into consolidated text and tool calls", async () => {
    const sseLines = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","model":"claude-3-7-sonnet-20250219"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me inspect the code"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"I will check the files for you."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool_call_abc","name":"read_file","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\": \\"index.ts\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    async function* mockStream() {
      for (const line of sseLines) {
        yield new TextEncoder().encode(line);
      }
    }

    const mockFetch = async () =>
      new Response(mockStream() as any, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });

    const client = new AnthropicClient({
      apiKey: "sk-ant-test",
      fetch: mockFetch as any,
    });

    const { stream, getConsolidated } = await client.streamMessages([
      { role: "user", content: "Inspect index.ts" },
    ]);

    const deltas = [];
    for await (const delta of stream) {
      deltas.push(delta);
    }

    assert.ok(deltas.length > 0);
    const consolidated = getConsolidated();
    assert.strictEqual(consolidated.role, "assistant");
    assert.strictEqual(consolidated.thinking, "Let me inspect the code");
    assert.strictEqual(consolidated.content, "I will check the files for you.");
    assert.ok(consolidated.tool_calls);
    assert.strictEqual(consolidated.tool_calls.length, 1);
    assert.strictEqual(consolidated.tool_calls[0].function.name, "read_file");
    assert.strictEqual(consolidated.tool_calls[0].function.arguments, '{"path": "index.ts"}');
  });
});
