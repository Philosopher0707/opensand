import test from "node:test";
import * as assert from "node:assert";
import {
  isAnthropicProvider,
  resolveAnthropicEndpoint,
  buildAnthropicPayload,
  parseAnthropicSSEStream,
} from "../src/anthropic-adapter.js";
import { ChatMessage, LLMClientConfig } from "../src/types.js";
import { ToolDefinition } from "@opensand/local-exec-daemon";

test("AnthropicAdapter - isAnthropicProvider detection", () => {
  assert.strictEqual(isAnthropicProvider({ baseUrl: "https://api.anthropic.com", model: "claude-3-7" }), true);
  assert.strictEqual(isAnthropicProvider({ baseUrl: "https://api.openai.com", model: "gpt-4o", provider: "anthropic" }), true);
  assert.strictEqual(isAnthropicProvider({ baseUrl: "http://localhost:11434", model: "claude-3-sonnet" }), true);
  assert.strictEqual(isAnthropicProvider({ baseUrl: "http://localhost:11434", model: "llama3.1" }), false);
});

test("AnthropicAdapter - resolveAnthropicEndpoint", () => {
  assert.strictEqual(resolveAnthropicEndpoint("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
  assert.strictEqual(resolveAnthropicEndpoint("https://api.anthropic.com/v1"), "https://api.anthropic.com/v1/messages");
  assert.strictEqual(resolveAnthropicEndpoint("https://api.anthropic.com/v1/messages"), "https://api.anthropic.com/v1/messages");
});

test("AnthropicAdapter - buildAnthropicPayload handles system prompt, messages, and tools", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are a coding assistant." },
    { role: "user", content: "Run git status" },
    {
      role: "assistant",
      content: "I will run the command.",
      tool_calls: [
        {
          id: "toolu_123",
          type: "function",
          function: {
            name: "exec_command",
            arguments: JSON.stringify({ command: "git status" }),
          },
        },
      ],
    },
    {
      role: "tool",
      name: "exec_command",
      tool_call_id: "toolu_123",
      content: "On branch main",
    },
  ];

  const tools: ToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "exec_command",
        description: "Run bash command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
  ];

  const config: LLMClientConfig = {
    baseUrl: "https://api.anthropic.com",
    model: "claude-3-7-sonnet-20250219",
    thinkingBudgetTokens: 2048,
  };

  const payload = buildAnthropicPayload(messages, tools, config);

  // System prompt isolated
  assert.strictEqual(payload.system, "You are a coding assistant.");
  assert.strictEqual(payload.model, "claude-3-7-sonnet-20250219");

  // Extended thinking configured
  assert.deepStrictEqual(payload.thinking, { type: "enabled", budget_tokens: 2048 });

  // Tools mapped to input_schema
  assert.strictEqual(payload.tools?.length, 1);
  assert.strictEqual(payload.tools?.[0].name, "exec_command");
  assert.deepStrictEqual(payload.tools?.[0].input_schema, {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  });

  // Messages structure: user -> assistant (tool_use) -> user (tool_result)
  assert.strictEqual(payload.messages.length, 3);
  assert.strictEqual(payload.messages[0].role, "user");
  assert.strictEqual(payload.messages[0].content, "Run git status");

  assert.strictEqual(payload.messages[1].role, "assistant");
  const assistantBlocks = payload.messages[1].content as Array<any>;
  assert.strictEqual(assistantBlocks[0].type, "text");
  assert.strictEqual(assistantBlocks[1].type, "tool_use");
  assert.strictEqual(assistantBlocks[1].id, "toolu_123");

  assert.strictEqual(payload.messages[2].role, "user");
  const toolResultBlocks = payload.messages[2].content as Array<any>;
  assert.strictEqual(toolResultBlocks[0].type, "tool_result");
  assert.strictEqual(toolResultBlocks[0].tool_use_id, "toolu_123");
  assert.strictEqual(toolResultBlocks[0].content, "On branch main");
});

test("AnthropicAdapter - parseAnthropicSSEStream streams text, thinking, and tool_use", async () => {
  const sseChunks = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me check the branch."}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Checking branch."}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_999","name":"exec_command","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\": \\"git"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":" status\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  async function* mockStream() {
    const encoder = new TextEncoder();
    for (const chunk of sseChunks) {
      yield encoder.encode(chunk);
    }
  }

  let finalState: any = null;
  const deltas: any[] = [];

  for await (const delta of parseAnthropicSSEStream(mockStream(), (state) => {
    finalState = state;
  })) {
    deltas.push(delta);
  }

  // Verify stream deltas received
  assert.ok(deltas.some((d) => d.thinking === "Let me check the branch."));
  assert.ok(deltas.some((d) => d.content === "Checking branch."));
  assert.ok(deltas.some((d) => d.tool_calls && d.tool_calls[0].id === "toolu_999"));

  // Verify accumulated state
  assert.strictEqual(finalState.thinking, "Let me check the branch.");
  assert.strictEqual(finalState.content, "Checking branch.");
  assert.strictEqual(finalState.toolCalls[2].name, "exec_command");
  assert.strictEqual(finalState.toolCalls[2].arguments, '{"command": "git status"}');
});
