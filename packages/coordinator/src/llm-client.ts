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

export class NetworkError extends Error {
  public readonly endpoint: string;
  public readonly code?: string;
  public readonly isNetworkError = true;

  constructor(message: string, endpoint: string, code?: string, cause?: unknown) {
    super(message);
    this.name = "NetworkError";
    this.endpoint = endpoint;
    this.code = code;
    if (cause) {
      this.cause = cause;
    }
  }
}

export function classifyNetworkError(
  err: any,
  endpoint: string,
  timeoutMs: number,
  isTimeout = false
): NetworkError {
  if (isTimeout) {
    return new NetworkError(
      `LLM API request timed out after ${timeoutMs}ms waiting for response from ${endpoint}`,
      endpoint,
      "ETIMEDOUT",
      err
    );
  }

  const causeCode = (err?.cause?.code || err?.code || "").toUpperCase();
  const rawMsg = err?.message || "";
  const causeMsg = err?.cause?.message || "";
  const combined = `${rawMsg} ${causeMsg} ${causeCode}`.toLowerCase();

  if (causeCode === "ECONNREFUSED" || combined.includes("econnrefused")) {
    return new NetworkError(
      `Connection refused to ${endpoint}. If running locally, verify that your model server is active (e.g. 'ollama serve').`,
      endpoint,
      "ECONNREFUSED",
      err
    );
  }

  if (
    causeCode === "ENOTFOUND" ||
    causeCode === "EAI_AGAIN" ||
    combined.includes("enotfound") ||
    combined.includes("eai_again") ||
    combined.includes("getaddrinfo")
  ) {
    const code = causeCode || "ENOTFOUND";
    return new NetworkError(
      `DNS lookup failed for ${endpoint} (${code}). Check your endpoint URL spelling and network connection.`,
      endpoint,
      code,
      err
    );
  }

  if (
    causeCode === "ENETUNREACH" ||
    causeCode === "EHOSTUNREACH" ||
    combined.includes("enetunreach") ||
    combined.includes("ehostunreach")
  ) {
    const code = causeCode || "ENETUNREACH";
    return new NetworkError(
      `Network unreachable for ${endpoint} (${code}). Check your network connection or VPN routing.`,
      endpoint,
      code,
      err
    );
  }

  if (
    causeCode === "ECONNRESET" ||
    causeCode === "EPIPE" ||
    causeCode === "UND_ERR_SOCKET" ||
    combined.includes("econnreset") ||
    combined.includes("epipe") ||
    combined.includes("socket hang up") ||
    combined.includes("connection reset")
  ) {
    const code = causeCode || "ECONNRESET";
    return new NetworkError(
      `Connection to ${endpoint} was reset. The model server may have closed the connection or crashed mid-stream.`,
      endpoint,
      code,
      err
    );
  }

  if (
    causeCode === "ETIMEDOUT" ||
    causeCode === "UND_ERR_CONNECT_TIMEOUT" ||
    combined.includes("etimedout") ||
    combined.includes("timed out")
  ) {
    return new NetworkError(
      `Connection to ${endpoint} timed out. The server may be overloaded or unreachable.`,
      endpoint,
      "ETIMEDOUT",
      err
    );
  }

  const detail = err?.cause?.message || err?.message || "network request failed";
  return new NetworkError(
    `Failed to connect to LLM at ${endpoint}: ${detail}`,
    endpoint,
    causeCode || "NETWORK_ERROR",
    err
  );
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
    const baseUrl = this.config.baseUrl?.trim();
    if (!baseUrl) {
      throw new Error(
        "LLM endpoint is not configured. Open Settings and set the endpoint URL (e.g. http://127.0.0.1:11434/v1)."
      );
    }
    if (isAnthropicProvider(this.config)) {
      return resolveAnthropicEndpoint(baseUrl);
    }
    const base = baseUrl.replace(/\/+$/, "");
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

  private calculateBackoff(attempt: number, retryAfterHeader?: string | null): number {
    if (retryAfterHeader) {
      const trimmed = retryAfterHeader.trim();
      if (/^\d+$/.test(trimmed)) {
        const secs = parseInt(trimmed, 10);
        if (!isNaN(secs) && secs >= 0) {
          return Math.min(secs * 1000, 30000);
        }
      }
      const parsedDate = Date.parse(trimmed);
      if (!isNaN(parsedDate)) {
        const diff = parsedDate - Date.now();
        return Math.min(Math.max(0, diff), 30000);
      }
    }

    const base = (this.config.initialBackoffMs ?? 500) * Math.pow(2, attempt - 1);
    const maxBackoff = this.config.maxBackoffMs ?? 30000;
    const jitter = Math.random() * Math.min(200, base * 0.2);
    return Math.min(base + jitter, maxBackoff);
  }

  private async sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    if (ms <= 0) return;
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      };
      timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async *wrapWithStallWatchdog(
    source: AsyncIterable<Uint8Array>,
    idleTimeoutMs: number,
    endpoint: string,
    signal?: AbortSignal
  ): AsyncIterable<Uint8Array> {
    let timer: NodeJS.Timeout | null = null;
    let isStalled = false;
    let triggerStall: (() => void) | null = null;

    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      isStalled = false;
      timer = setTimeout(() => {
        isStalled = true;
        if (triggerStall) {
          triggerStall();
        }
      }, idleTimeoutMs);
    };

    try {
      resetTimer();
      const iterator = source[Symbol.asyncIterator]();
      while (true) {
        if (signal?.aborted) {
          break;
        }
        if (isStalled) {
          throw new NetworkError(
            `LLM API stream stalled: no data received for ${idleTimeoutMs}ms from ${endpoint}`,
            endpoint,
            "ETIMEDOUT"
          );
        }

        const stallPromise = new Promise<never>((_, reject) => {
          triggerStall = () => {
            reject(
              new NetworkError(
                `LLM API stream stalled: no data received for ${idleTimeoutMs}ms from ${endpoint}`,
                endpoint,
                "ETIMEDOUT"
              )
            );
          };
        });

        let abortPromise: Promise<never> | undefined;
        let abortHandler: (() => void) | undefined;
        if (signal) {
          abortPromise = new Promise<never>((_, reject) => {
            abortHandler = () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            };
            signal.addEventListener("abort", abortHandler, { once: true });
          });
        }

        const promises: Promise<any>[] = [iterator.next(), stallPromise];
        if (abortPromise) promises.push(abortPromise);

        let result: IteratorResult<Uint8Array>;
        try {
          result = await Promise.race(promises);
        } finally {
          triggerStall = null;
          if (abortHandler && signal) {
            signal.removeEventListener("abort", abortHandler);
          }
        }

        if (result.done) {
          break;
        }

        resetTimer();
        yield result.value;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

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
      headers["anthropic-beta"] = "prompt-caching-2024-07-31";
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

    const maxRetries = this.config.maxRetries ?? 3;
    let attempt = 0;
    const fetchFn = this.config.fetch ?? globalThis.fetch;
    const timeoutMs = this.config.timeoutMs ?? 120000;
    let response!: Response;

    while (true) {
      if (signal?.aborted) {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      }

      const timeoutController = new AbortController();
      const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      try {
        response = await fetchFn(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: combinedSignal,
        });
      } catch (networkErr: any) {
        clearTimeout(timeoutTimer);
        if (signal?.aborted || (networkErr?.name === "AbortError" && signal?.aborted)) {
          throw networkErr;
        }

        const isTimeout = timeoutController.signal.aborted && !signal?.aborted;
        const classified = classifyNetworkError(networkErr, endpoint, timeoutMs, isTimeout);

        const isRetryableNetwork =
          classified.code === "ECONNRESET" ||
          classified.code === "ETIMEDOUT" ||
          classified.code === "EPIPE";

        if (isRetryableNetwork && attempt < maxRetries && !signal?.aborted) {
          attempt++;
          const delayMs = this.calculateBackoff(attempt);
          await this.sleepWithAbort(delayMs, signal);
          continue;
        }

        throw classified;
      } finally {
        clearTimeout(timeoutTimer);
      }

      if (!response.ok) {
        const status = response.status;
        const isRetryableStatus =
          status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

        if (isRetryableStatus && attempt < maxRetries && !signal?.aborted) {
          attempt++;
          const retryAfter =
            response.headers?.get?.("retry-after") ??
            response.headers?.get?.("Retry-After") ??
            (response.headers as any)?.["retry-after"] ??
            (response.headers as any)?.["Retry-After"];
          const delayMs = this.calculateBackoff(attempt, retryAfter);
          await this.sleepWithAbort(delayMs, signal);
          continue;
        }

        const errorText = await response.text();
        let detail = errorText;
        try {
          const parsed = JSON.parse(errorText);
          if (parsed.error?.message) {
            detail = parsed.error.message;
          } else if (parsed.message) {
            detail = parsed.message;
          }
        } catch {
          // Retain raw errorText
        }

        if (response.status === 401) {
          throw new Error(
            `Authentication failed (401 Unauthorized) at ${endpoint}.\n` +
            `  Detail: ${detail}\n` +
            `  Fix: Provide an API key via --api-key, export OPENAI_API_KEY, or use a local model (--endpoint http://127.0.0.1:11434/v1).`
          );
        }

        if (response.status === 403) {
          throw new Error(
            `Access forbidden (403 Forbidden) at ${endpoint}.\n` +
            `  Detail: ${detail}\n` +
            `  Fix: Check your API key permissions and model access.`
          );
        }

        if (response.status === 404) {
          throw new Error(
            `Model or endpoint not found (404 Not Found) at ${endpoint}.\n` +
            `  Detail: ${detail}\n` +
            `  Fix: Check available models (e.g. 'ollama list') and specify with --model <name>.`
          );
        }

        if (response.status === 429) {
          throw new Error(
            `Rate limit or quota exceeded (429 Too Many Requests) at ${endpoint}.\n` +
            `  Detail: ${detail}`
          );
        }

        throw new Error(`LLM API request failed [${response.status} ${response.statusText}]: ${detail}`);
      }

      break;
    }

    if (!response.body) {
      throw new Error("LLM API returned empty response body");
    }

    const idleTimeoutMs = this.config.streamIdleTimeoutMs ?? 60000;
    const rawStream = this.wrapWithStallWatchdog(
      response.body as unknown as AsyncIterable<Uint8Array>,
      idleTimeoutMs,
      endpoint,
      signal
    );

    if (isAnthropic) {
      let state = {
        content: "",
        thinking: "",
        toolCalls: {} as Record<number, { id: string; name: string; arguments: string }>,
      };

      const anthropicStream = parseAnthropicSSEStream(rawStream, (s) => {
        state = s;
      });

      async function* anthropicGenerator(): AsyncIterable<StreamDelta> {
        try {
          for await (const delta of anthropicStream) {
            yield delta;
          }
        } catch (streamErr: any) {
          if (signal?.aborted || streamErr?.name === "AbortError") {
            return;
          }
          throw classifyNetworkError(streamErr, endpoint, timeoutMs, false);
        }
      }

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

      return { stream: anthropicGenerator(), getConsolidated };
    }

    // OpenAI-compatible streaming
    let fullContent = "";
    let fullThinking = "";
    const toolCallAccumulator: Record<
      number,
      { id: string; name: string; arguments: string }
    > = {};

    async function* generator(): AsyncIterable<StreamDelta> {
      try {
        for await (const rawPayload of parseSSEStream(rawStream)) {
          if (signal?.aborted) {
            break;
          }
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

          const reasoning = delta.reasoning_content || delta.thought;
          if (reasoning) {
            fullThinking += reasoning;
            streamDelta.thinking = reasoning;
          }

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
      } catch (streamErr: any) {
        if (signal?.aborted || streamErr?.name === "AbortError") {
          return;
        }
        if (streamErr instanceof NetworkError) {
          throw streamErr;
        }
        throw classifyNetworkError(streamErr, endpoint, timeoutMs, false);
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
        thinking: fullThinking.length > 0 ? fullThinking : undefined,
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
