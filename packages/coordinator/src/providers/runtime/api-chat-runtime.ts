/**
 * Shared API-key runtime for OpenAI-compatible and Anthropic chat drivers.
 * Reuses the coordinator's UniversalLLMClient, which already provides bounded
 * timeouts, retry/backoff, idle-stream detection and HTTP error mapping.
 */

import type {
  ChatMessage,
  DriverCreateInput,
  ModelCatalog,
  ProviderInstance,
  ProviderSnapshot,
  TextGenerationUsage,
} from "@opensand/shared";
import { UniversalLLMClient } from "../../llm-client.js";

export interface ApiChatConfig {
  url: string;
  apiKeyEnv: string;
}

export interface ApiRuntimeOptions {
  driverKind: string;
  displayName: string;
  models: ModelCatalog;
  provider: "anthropic" | "openrouter";
  headers?: Record<string, string>;
}

/** API instances expose their configured client so the app's turn loop can
 * reuse the driver's hardened transport (timeouts, retries, error mapping). */
export interface ApiProviderInstance extends ProviderInstance {
  createLlmClient(model?: string): UniversalLLMClient;
}

const TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

/** Build a ProviderInstance backed by an HTTP chat-completions-style API. */
export function createApiInstance(
  input: DriverCreateInput<ApiChatConfig>,
  options: ApiRuntimeOptions
): ProviderInstance {
  const { config } = input;
  const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
  const listeners = new Set<(event: unknown) => void>();
  let models = options.models;
  let modelsUnconfirmed = false;
  let disposed = false;

  const emit = (event: unknown): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A bad listener must not break a turn.
      }
    }
  };

  const makeClient = (model: string): UniversalLLMClient =>
    new UniversalLLMClient({
      baseUrl: config.url,
      apiKey,
      model,
      provider: options.provider,
      ...(options.headers ? { headers: options.headers } : {}),
      timeoutMs: TIMEOUT_MS,
      streamIdleTimeoutMs: IDLE_TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
    });

  const toMessages = (turn: {
    text: string;
    system?: string;
    transcript?: Array<{ role: "user" | "assistant"; text: string }>;
  }): ChatMessage[] => {
    const messages: ChatMessage[] = (turn.transcript ?? []).map((entry) => ({
      role: entry.role,
      content: entry.text,
    }));
    if (!turn.transcript?.length) messages.push({ role: "user", content: turn.text });
    if (turn.system) messages.unshift({ role: "system", content: turn.system });
    return messages;
  };

  const streamText = async (client: UniversalLLMClient, messages: ChatMessage[], signal?: AbortSignal): Promise<string> => {
    const { stream, getConsolidated } = await client.streamCompletion(messages, undefined, signal);
    let streamed = "";
    for await (const delta of stream) {
      if (delta.content) {
        streamed += delta.content;
        emit({ type: "text.delta", text: delta.content });
      }
    }
    const consolidated = getConsolidated();
    return consolidated.content ?? streamed;
  };

  const instance: ApiProviderInstance = {
    instanceId: input.instanceId,
    driverKind: options.driverKind as ProviderInstance["driverKind"],
    displayName: input.displayName,
    enabled: input.enabled,
    get models() {
      return models;
    },
    get modelsUnconfirmed() {
      return modelsUnconfirmed;
    },
    async refreshModels() {
      if (disposed) return;
      if (!apiKey) {
        modelsUnconfirmed = true;
        return;
      }
      const url = config.url.replace(/\/+$/, "") + "/models";
      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
          redirect: "error",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload: unknown = await response.json();
        const rows = Array.isArray(payload)
          ? payload
          : (payload as { data?: unknown[] } | null)?.data ?? [];
        const discovered = rows
          .map((row) => {
            const item = row as { id?: unknown; name?: unknown; context_length?: unknown };
            return typeof item.id === "string"
              ? {
                  id: item.id,
                  label: typeof item.name === "string" ? item.name : item.id,
                  ...(typeof item.context_length === "number" ? { contextWindow: item.context_length } : {}),
                }
              : null;
          })
          .filter((entry): entry is { id: string; label: string; contextWindow?: number } => entry !== null);
        if (discovered.length) {
          models = {
            default: discovered.some((m) => m.id === models.default) ? models.default : discovered[0].id,
            options: discovered,
          };
          modelsUnconfirmed = false;
        } else {
          modelsUnconfirmed = true;
        }
      } catch {
        modelsUnconfirmed = true;
      }
    },
    async snapshot(): Promise<ProviderSnapshot> {
      return {
        instanceId: input.instanceId,
        driverKind: options.driverKind as ProviderInstance["driverKind"],
        enabled: input.enabled,
        ...(apiKey
          ? {}
          : { error: { code: "invalid_credentials", message: `No ${config.apiKeyEnv} set` } as const }),
      };
    },
    adapter: {
      provider: options.driverKind as ProviderInstance["driverKind"],
      capabilities: {
        sessionModelSwitch: "in-session",
        guestTurns: "unconfined",
        agentsMcp: false,
        customMcp: false,
        computerMcp: false,
        composioMcp: false,
        mcpToolsFoundByName: false,
        phoneMcp: false,
        browserMcp: false,
        dataMcp: false,
        emailMcp: false,
        deviceMcp: false,
        images: false,
        nativeImageInput: false,
        effortLevels: [],
        queueing: false,
        steerImages: false,
        strictResume: false,
        localComputerMcp: false,
        hooks: false,
      },
      async sendTurn(turn) {
        if (disposed) throw new Error(`${options.driverKind} provider ${input.instanceId} is disposed`);
        return streamText(
          makeClient(turn.model ?? options.models.default),
          toMessages(turn)
        );
      },
      steer() {
        return Promise.resolve();
      },
      interruptTurn() {
        return Promise.resolve();
      },
      respondToRequest() {
        return Promise.resolve("unavailable");
      },
      hasSession() {
        return false;
      },
      enginePid() {
        return undefined;
      },
      async stopAll() {},
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    async generateText(prompt, genOptions) {
      if (disposed) throw new Error(`${options.driverKind} provider ${input.instanceId} is disposed`);
      const model = genOptions?.model ?? options.models.default;
      const client = makeClient(model);
      const text = await streamText(client, [{ role: "user", content: prompt }], genOptions?.signal);
      const usage: TextGenerationUsage = {
        model,
        input: prompt.length,
        output: text.length,
      };
      genOptions?.onUsage?.(usage);
      return text;
    },
    createLlmClient(model) {
      return makeClient(model ?? models.default);
    },
    async dispose() {
      disposed = true;
      listeners.clear();
    },
  };

  return instance;
}
