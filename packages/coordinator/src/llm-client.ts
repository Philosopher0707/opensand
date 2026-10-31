import { ChatMessage, LLMClientConfig, StreamDelta, ToolCall } from "./types.js";
import { ToolDefinition } from "@opensand/local-exec-daemon";
import { parseSSEStream } from "./sse-parser.js";

export interface ConsolidatedAssistantResponse {
  role: "assistant";
  content: string | null;
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
   * Stream a chat completion turn from an OpenAI-compatible API endpoint.
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
    const endpoint = this.resolveEndpoint();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.config.headers ?? {}),
    };

    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

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

    const response = await fetch(endpoint, {
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

    let fullContent = "";
    const toolCallAccumulator: Record<
      number,
      { id: string; name: string; arguments: string }
    > = {};

    const rawStream = response.body as unknown as AsyncIterable<Uint8Array>;
    const self = this;

    async function* generator(): AsyncIterable<StreamDelta> {
      for await (const rawPayload of parseSSEStream(rawStream)) {
        if (rawPayload === "[DONE]") {
          break;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          continue;
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (!delta) continue;

        const streamDelta: StreamDelta = {
          content: delta.content ?? undefined,
          tool_calls: delta.tool_calls ?? undefined,
          finish_reason: choice.finish_reason ?? null,
        };

        if (streamDelta.content) {
          fullContent += streamDelta.content;
        }

        if (streamDelta.tool_calls) {
          for (const tc of streamDelta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAccumulator[idx]) {
              toolCallAccumulator[idx] = {
                id: tc.id ?? `call_${Date.now()}_${idx}`,
                name: tc.function?.name ?? "",
                arguments: tc.function?.arguments ?? "",
              };
            } else {
              if (tc.id) toolCallAccumulator[idx].id = tc.id;
              if (tc.function?.name) toolCallAccumulator[idx].name += tc.function.name;
              if (tc.function?.arguments) toolCallAccumulator[idx].arguments += tc.function.arguments;
            }
          }
        }

        yield streamDelta;
      }
    }

    return {
      stream: generator(),
      getConsolidated: (): ConsolidatedAssistantResponse => {
        const toolCalls: ToolCall[] = Object.keys(toolCallAccumulator)
          .map(Number)
          .sort((a, b) => a - b)
          .map((idx) => {
            const entry = toolCallAccumulator[idx];
            return {
              id: entry.id,
              type: "function" as const,
              function: {
                name: entry.name,
                arguments: entry.arguments,
              },
            };
          });

        return {
          role: "assistant",
          content: fullContent.length > 0 ? fullContent : null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        };
      },
    };
  }
}
