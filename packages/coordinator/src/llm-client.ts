import { ChatMessage, LLMClientConfig, StreamDelta, ToolCall } from "./types.js";
import { ToolDefinition } from "@opensand/local-exec-daemon";
import { parseSSEStream } from "./sse-parser.js";
import {
  isAnthropicProvider,
  resolveAnthropicEndpoint,
  buildAnthropicPayload,
  parseAnthropicSSEStream,
} from "./anthropic-adapter.js";

export interface ConsolidatedAssistantResponse {
  role: "assistant";
  content: string | null;
  thinking?: string;
  tool_calls?: ToolCall[];
}

export class UniversalLLMClient {
  private config: LLMClientConfig;

  constructor(config: LLMClientConfig) {
    this.config = config;
  }

  get model(): string {
    return this.config.model;
  }

  private resolveEndpoint(): string {
    if (isAnthropicProvider(this.config)) {
      return resolveAnthropicEndpoint(this.config.baseUrl);
    }
    const base = this.config.baseUrl.replace(/\/+$/, "");
    if (base.endsWith("/chat/completions")) {
      return base;
    }
    if (base.endsWith("/v1")) {
      return `${base}/chat/completions`;
    }
    return `${base}/v1/chat/completions`;
  }

  /**
   * Stream a chat completion turn from an OpenAI-compatible or Anthropic API endpoint.
   * Yields StreamDelta as tokens and tool chunks arrive, and returns
   * the consolidated assistant response at the end.
   */
  async streamCompletion(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    signal?: AbortSignal
  ): Promise<{
    stream: AsyncIterable<StreamDelta>;
    getConsolidated: () => ConsolidatedAssistantResponse;
  }> {
    const isAnthropic = isAnthropicProvider(this.config);
    const endpoint = this.resolveEndpoint();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.config.headers ?? {}),
    };

    if (isAnthropic) {
      headers["anthropic-version"] = "2023-06-01";
      if (this.config.apiKey) {
        headers["x-api-key"] = this.config.apiKey;
      }
    } else {
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }
    }

    const body = isAnthropic
      ? buildAnthropicPayload(messages, tools, this.config)
      : this.buildOpenAIPayload(messages, tools);

    const fetchFn = this.config.fetch ?? globalThis.fetch;
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API request failed [${response.status} ${response.statusText}]: ${errorText}`);
    }

    if (!response.body) {
      throw new Error("LLM API returned empty response body");
    }

    const rawStream = response.body as unknown as AsyncIterable<Uint8Array>;

    if (isAnthropic) {
      let state = {
        content: "",
        thinking: "",
        toolCalls: {} as Record<number, { id: string; name: string; arguments: string }>,
      };

      const stream = parseAnthropicSSEStream(rawStream, (s) => {
        state = s;
      });

      const getConsolidated = (): ConsolidatedAssistantResponse => {
        const toolCalls: ToolCall[] = Object.values(state.toolCalls).map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));

        return {
          role: "assistant",
          content: state.content.length > 0 ? state.content : null,
          thinking: state.thinking.length > 0 ? state.thinking : undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        };
      };

      return { stream, getConsolidated };
    }

    // OpenAI-compatible streaming
    let fullContent = "";
    const toolCallAccumulator: Record<
      number,
      { id: string; name: string; arguments: string }
    > = {};

    async function* generator(): AsyncIterable<StreamDelta> {
      for await (const rawPayload of parseSSEStream(rawStream)) {
        if (rawPayload === "[DONE]") {
          break;
        }

        let chunk: any;
        try {
          chunk = JSON.parse(rawPayload);
        } catch {
          continue;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (!delta) continue;

        const streamDelta: StreamDelta = {
          finish_reason: choice.finish_reason ?? null,
        };

        if (delta.content) {
          fullContent += delta.content;
          streamDelta.content = delta.content;
        }

        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
          streamDelta.tool_calls = delta.tool_calls;
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0;
            if (!toolCallAccumulator[index]) {
              toolCallAccumulator[index] = {
                id: tc.id ?? `call_${Date.now()}_${index}`,
                name: tc.function?.name ?? "",
                arguments: "",
              };
            }
            if (tc.id) {
              toolCallAccumulator[index].id = tc.id;
            }
            if (tc.function?.name) {
              toolCallAccumulator[index].name = tc.function.name;
            }
            if (tc.function?.arguments) {
              toolCallAccumulator[index].arguments += tc.function.arguments;
            }
          }
        }

        yield streamDelta;
      }
    }

    const getConsolidated = (): ConsolidatedAssistantResponse => {
      const toolCalls: ToolCall[] = Object.values(toolCallAccumulator).map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));

      return {
        role: "assistant",
        content: fullContent.length > 0 ? fullContent : null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    };

    return {
      stream: generator(),
      getConsolidated,
    };
  }

  private buildOpenAIPayload(messages: ChatMessage[], tools?: ToolDefinition[]): Record<string, any> {
    const body: Record<string, any> = {
      model: this.config.model,
      messages,
      stream: true,
    };

    if (this.config.temperature !== undefined) {
      body.temperature = this.config.temperature;
    }
    if (this.config.maxTokens !== undefined) {
      body.max_tokens = this.config.maxTokens;
    }
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    return body;
  }
}
