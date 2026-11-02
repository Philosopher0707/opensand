import { ChatMessage, LLMClientConfig, StreamDelta, ToolCall } from "./types.js";
import { ToolDefinition } from "@opensand/local-exec-daemon";
import { parseSSEStream } from "./sse-parser.js";
import { ConsolidatedAssistantResponse } from "./llm-client.js";

export function isAnthropicProvider(config: LLMClientConfig): boolean {
  if (config.provider === "anthropic") return true;
  if (config.baseUrl.includes("anthropic.com") || config.baseUrl.endsWith("/v1/messages")) return true;
  if (config.model.toLowerCase().startsWith("claude")) return true;
  return false;
}

export function resolveAnthropicEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/messages")) return base;
  if (base.endsWith("/v1")) return `${base}/messages`;
  return `${base}/v1/messages`;
}

export interface AnthropicMessagePayload {
  model: string;
  max_tokens: number;
  system?: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<Record<string, unknown>>;
  }>;
  tools?: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    cache_control?: { type: "ephemeral" };
  }>;
  thinking?: {
    type: "enabled";
    budget_tokens: number;
  };
  stream: true;
}

export function buildAnthropicPayload(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  config?: LLMClientConfig
): AnthropicMessagePayload {
  let systemPrompt = "";
  const anthropicMessages: Array<{
    role: "user" | "assistant";
    content: string | Array<Record<string, unknown>>;
  }> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      if (systemPrompt) systemPrompt += "\n\n";
      systemPrompt += msg.content || "";
      continue;
    }

    if (msg.role === "user") {
      // Merge with previous user message if contiguous
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === "user") {
        if (typeof last.content === "string") {
          last.content = [{ type: "text", text: last.content }, { type: "text", text: msg.content || "" }];
        } else if (Array.isArray(last.content)) {
          last.content.push({ type: "text", text: msg.content || "" });
        }
      } else {
        anthropicMessages.push({
          role: "user",
          content: msg.content || "",
        });
      }
    } else if (msg.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      if (msg.content) {
        blocks.push({ type: "text", text: msg.content });
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments || "{}");
          } catch {
            parsedArgs = {};
          }
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parsedArgs,
          });
        }
      }

      anthropicMessages.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : (msg.content || ""),
      });
    } else if (msg.role === "tool") {
      // Tool results are represented as user role with tool_result block in Anthropic
      const toolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "unknown",
        content: msg.content || "",
      };

      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(toolResultBlock);
      } else if (last && last.role === "user" && typeof last.content === "string") {
        last.content = [{ type: "text", text: last.content }, toolResultBlock];
      } else {
        anthropicMessages.push({
          role: "user",
          content: [toolResultBlock],
        });
      }
    }
  }

  const payload: AnthropicMessagePayload = {
    model: config?.model || "claude-3-7-sonnet-20250219",
    max_tokens: config?.maxTokens ?? 4096,
    messages: anthropicMessages,
    stream: true,
  };

  if (systemPrompt) {
    if (config?.enablePromptCaching) {
      payload.system = [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ];
    } else {
      payload.system = systemPrompt;
    }
  }

  if (config?.thinkingBudgetTokens && config.thinkingBudgetTokens > 0) {
    payload.thinking = {
      type: "enabled",
      budget_tokens: config.thinkingBudgetTokens,
    };
  }

  if (tools && tools.length > 0) {
    payload.tools = tools.map((t, idx) => {
      const toolObj: {
        name: string;
        description: string;
        input_schema: Record<string, unknown>;
        cache_control?: { type: "ephemeral" };
      } = {
        name: t.function.name,
        description: t.function.description,
        input_schema: (t.function.parameters as Record<string, unknown>) || { type: "object", properties: {} },
      };
      if (config?.enablePromptCaching && idx === tools.length - 1) {
        toolObj.cache_control = { type: "ephemeral" };
      }
      return toolObj;
    });
  }

  return payload;
}

export async function* parseAnthropicSSEStream(
  rawStream: AsyncIterable<Uint8Array>,
  onStateUpdate: (state: {
    content: string;
    thinking: string;
    toolCalls: Record<number, { id: string; name: string; arguments: string }>;
  }) => void
): AsyncIterable<StreamDelta> {
  let fullContent = "";
  let fullThinking = "";
  const toolCallAccumulator: Record<number, { id: string; name: string; arguments: string }> = {};

  for await (const rawPayload of parseSSEStream(rawStream)) {
    let eventObj: any;
    try {
      eventObj = JSON.parse(rawPayload);
    } catch {
      continue;
    }

    const type = eventObj.type;

    if (type === "content_block_start") {
      const block = eventObj.content_block;
      const index = eventObj.index ?? 0;
      if (block?.type === "tool_use") {
        toolCallAccumulator[index] = {
          id: block.id || `toolu_${Date.now()}_${index}`,
          name: block.name || "",
          arguments: "",
        };
        yield {
          tool_calls: [
            {
              index,
              id: toolCallAccumulator[index].id,
              type: "function",
              function: {
                name: toolCallAccumulator[index].name,
                arguments: "",
              },
            },
          ],
        };
      }
    } else if (type === "content_block_delta") {
      const delta = eventObj.delta;
      const index = eventObj.index ?? 0;

      if (delta?.type === "text_delta" && delta.text) {
        fullContent += delta.text;
        yield { content: delta.text };
      } else if (delta?.type === "thinking_delta" && delta.thinking) {
        fullThinking += delta.thinking;
        yield { thinking: delta.thinking };
      } else if (delta?.type === "input_json_delta" && delta.partial_json) {
        if (!toolCallAccumulator[index]) {
          toolCallAccumulator[index] = { id: `toolu_${Date.now()}_${index}`, name: "", arguments: "" };
        }
        toolCallAccumulator[index].arguments += delta.partial_json;
        yield {
          tool_calls: [
            {
              index,
              id: toolCallAccumulator[index].id,
              type: "function",
              function: {
                arguments: delta.partial_json,
              },
            },
          ],
        };
      }
    }

    onStateUpdate({
      content: fullContent,
      thinking: fullThinking,
      toolCalls: toolCallAccumulator,
    });
  }
}
