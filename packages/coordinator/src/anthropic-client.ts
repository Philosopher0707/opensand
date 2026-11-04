import { ChatMessage, StreamDelta, ToolCall } from "./types.js";
import { ToolDefinition } from "@opensand/local-exec-daemon";
import { ConsolidatedAssistantResponse } from "./llm-client.js";
import {
  resolveAnthropicEndpoint,
  buildAnthropicPayload,
  parseAnthropicSSEStream,
} from "./anthropic-adapter.js";

export interface AnthropicClientConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  version?: string;
  betaHeaders?: string[];
  maxTokens?: number;
  thinkingBudgetTokens?: number;
  enablePromptCaching?: boolean;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface AnthropicModelMetadata {
  id: string;
  name: string;
  context_length: number;
  max_output_tokens: number;
  supports_thinking: boolean;
  supports_prompt_caching: boolean;
}

export const ANTHROPIC_KNOWN_MODELS: AnthropicModelMetadata[] = [
  {
    id: "claude-3-7-sonnet-20250219",
    name: "Claude 3.7 Sonnet (Hybrid Reasoning)",
    context_length: 200000,
    max_output_tokens: 64000,
    supports_thinking: true,
    supports_prompt_caching: true,
  },
  {
    id: "claude-3-5-sonnet-20241022",
    name: "Claude 3.5 Sonnet",
    context_length: 200000,
    max_output_tokens: 8192,
    supports_thinking: false,
    supports_prompt_caching: true,
  },
  {
    id: "claude-3-5-haiku-20241022",
    name: "Claude 3.5 Haiku",
    context_length: 200000,
    max_output_tokens: 8192,
    supports_thinking: false,
    supports_prompt_caching: true,
  },
  {
    id: "claude-3-opus-20240229",
    name: "Claude 3 Opus",
    context_length: 200000,
    max_output_tokens: 4096,
    supports_thinking: false,
    supports_prompt_caching: true,
  },
];

/**
 * Anthropic API Client Module
 * First-class native integration for Anthropic's Claude Messages API (/v1/messages).
 * Supports prompt caching (cache_control ephemeral), streaming thinking blocks,
 * and tool-use calling without external heavy dependencies.
 */
export class AnthropicClient {
  public readonly config: AnthropicClientConfig;
  private fetchFn: typeof globalThis.fetch;

  constructor(config: AnthropicClientConfig = {}) {
    this.config = {
      baseUrl: config.baseUrl || "https://api.anthropic.com/v1",
      model: config.model || "claude-3-7-sonnet-20250219",
      version: config.version || "2023-06-01",
      maxTokens: config.maxTokens ?? 4096,
      timeoutMs: config.timeoutMs ?? 120000,
      enablePromptCaching: config.enablePromptCaching ?? true,
      ...config,
    };
    this.fetchFn = config.fetch ?? globalThis.fetch;
  }

  public get model(): string {
    return this.config.model!;
  }

  public resolveEndpoint(): string {
    return resolveAnthropicEndpoint(this.config.baseUrl!);
  }

  /**
   * Stream a chat completion turn from Anthropic Messages API.
   * Yields StreamDelta as content chunks, thinking deltas, and tool calls arrive.
   */
  public async streamMessages(
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
      "anthropic-version": this.config.version || "2023-06-01",
    };

    const betas = ["prompt-caching-2024-07-31", ...(this.config.betaHeaders || [])];
    headers["anthropic-beta"] = betas.join(",");

    if (this.config.apiKey && this.config.apiKey !== "none") {
      headers["x-api-key"] = this.config.apiKey;
    }

    const payload = buildAnthropicPayload(messages, tools, {
      baseUrl: this.config.baseUrl!,
      model: this.config.model!,
      apiKey: this.config.apiKey,
      maxTokens: this.config.maxTokens,
      thinkingBudgetTokens: this.config.thinkingBudgetTokens,
      enablePromptCaching: this.config.enablePromptCaching,
    });

    const timeoutMs = this.config.timeoutMs ?? 120000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: combinedSignal,
      });
    } catch (networkErr: any) {
      if (timeoutSignal.aborted && !signal?.aborted) {
        throw new Error(`Anthropic API request timed out after ${timeoutMs}ms waiting for response from ${endpoint}`);
      }
      throw networkErr;
    }

    if (!response.ok) {
      const errText = await response.text();
      let msg = `Anthropic API error (${response.status}): ${errText}`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error?.message) {
          msg = `Anthropic API [${response.status} ${parsed.error.type || "error"}]: ${parsed.error.message}`;
        }
      } catch {
        // Not JSON
      }
      throw new Error(msg);
    }

    if (!response.body) {
      throw new Error("Anthropic API returned empty response body");
    }

    let state = {
      content: "",
      thinking: "",
      toolCalls: {} as Record<number, { id: string; name: string; arguments: string }>,
    };

    const rawStream = response.body as unknown as AsyncIterable<Uint8Array>;
    const stream = parseAnthropicSSEStream(rawStream, (s) => {
      state = s;
    });

    return {
      stream,
      getConsolidated: () => {
        const sortedToolCalls: ToolCall[] = Object.keys(state.toolCalls)
          .map(Number)
          .sort((a, b) => a - b)
          .map((k) => {
            const tc = state.toolCalls[k];
            return {
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: tc.arguments,
              },
            };
          });

        return {
          role: "assistant",
          content: state.content || null,
          thinking: state.thinking || undefined,
          tool_calls: sortedToolCalls.length > 0 ? sortedToolCalls : undefined,
        };
      },
    };
  }

  /**
   * Send a complete turn and return consolidated response without manual streaming.
   */
  public async createMessage(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    signal?: AbortSignal
  ): Promise<ConsolidatedAssistantResponse> {
    const { stream, getConsolidated } = await this.streamMessages(messages, tools, signal);
    // Drain stream
    for await (const _ of stream) {
      // consume
    }
    return getConsolidated();
  }

  /**
   * List known Anthropic Claude models and their metadata.
   */
  public listModels(): AnthropicModelMetadata[] {
    return [...ANTHROPIC_KNOWN_MODELS];
  }

  /**
   * Rough token estimation for Anthropic messages (~3.8 chars/token).
   */
  public countTokens(messages: ChatMessage[]): number {
    let totalChars = 0;
    for (const msg of messages) {
      if (msg.content) totalChars += msg.content.length;
    }
    return Math.ceil(totalChars / 3.8);
  }

  /**
   * Health check / probe against the Anthropic endpoint.
   */
  public async testConnection(): Promise<{ ok: boolean; message: string; model?: string }> {
    try {
      const messages: ChatMessage[] = [{ role: "user", content: "ping" }];
      const res = await this.createMessage(messages);
      return { ok: true, message: "Anthropic connection successful", model: this.config.model };
    } catch (err: any) {
      return { ok: false, message: err.message, model: this.config.model };
    }
  }
}
