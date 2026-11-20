/**
 * OpenRouter provider driver — API-key driver over the OpenAI chat-completions
 * contract. No local binary; config is just the base URL and API key env name.
 * Matches OpenMausBot's drivers/grok.ts pattern.
 */

import { UniversalLLMClient } from "../llm-client.js";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
} from "@opensand/shared";

const DRIVER_KIND = "openrouter";
const DEFAULT_URL = "https://openrouter.ai/api/v1";

const MODELS: ModelCatalog = {
  default: "openrouter/auto",
  options: [
    { id: "openrouter/auto", label: "OpenRouter Auto", contextWindow: 128_000 },
    { id: "anthropic/claude-3.7-sonnet", label: "Claude 3.7 Sonnet", contextWindow: 200_000 },
    { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet", contextWindow: 200_000 },
    { id: "openai/gpt-4o", label: "GPT-4o", contextWindow: 128_000 },
    { id: "openai/gpt-4o-mini", label: "GPT-4o Mini", contextWindow: 128_000 },
    { id: "meta-llama/llama-3.1-405b-instruct", label: "Llama 3.1 405B", contextWindow: 128_000 },
    { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", contextWindow: 1_000_000 },
    { id: "x-ai/grok-4", label: "Grok 4", contextWindow: 1_000_000 },
  ],
};

export interface OpenRouterConfig {
  url: string;
  apiKeyEnv: string;
}

function decodeConfig(raw: unknown): OpenRouterConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  return {
    url: typeof config.url === "string" ? config.url : DEFAULT_URL,
    apiKeyEnv: typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : "OPENROUTER_API_KEY",
  };
}

export const OpenRouterDriver: ProviderDriver<OpenRouterConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenRouter",
    supportsMultipleInstances: true,
    access: "api",
  },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";

    const client = new UniversalLLMClient({
      baseUrl: config.url,
      apiKey,
      model: MODELS.default,
      provider: "openrouter",
      headers: {
        "HTTP-Referer": "https://opensand.dev",
        "X-Title": "OpenSand",
      },
    });

    let models = MODELS;

    const instance: ProviderInstance = {
      instanceId: input.instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      async refreshModels() {
        // OpenRouter has a static catalog for now; refresh is a no-op.
        models = MODELS;
      },
      adapter: {
        provider: DRIVER_KIND,
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
          // Delegate to the coordinator's LLM client stream; the adapter is
          // the turn-entry point for provider-specific execution.
          const client2 = new UniversalLLMClient({
            baseUrl: config.url,
            apiKey,
            model: turn.model ?? MODELS.default,
            provider: "openrouter",
            headers: {
              "HTTP-Referer": "https://opensand.dev",
              "X-Title": "OpenSand",
            },
          });
          const messages = turn.transcript
            ? turn.transcript.map((t) => ({ role: t.role, content: t.text }))
            : [{ role: "user", content: turn.text }];
          if (turn.system) {
            messages.unshift({ role: "system", content: turn.system });
          }
          const { stream, getConsolidated } = await client2.streamCompletion(messages);
          const chunks: string[] = [];
          for await (const delta of stream) {
            if (delta.content) chunks.push(delta.content);
          }
          return getConsolidated();
        },
        steer(_threadId, _instruction) {
          return Promise.resolve();
        },
        interruptTurn(_threadId) {
          return Promise.resolve();
        },
        respondToRequest(_threadId, _requestId, _decision) {
          return Promise.resolve("unavailable");
        },
        hasSession(_threadId) {
          return false;
        },
        enginePid(_threadId) {
          return undefined;
        },
        async stopAll() {
          return;
        },
        onEvent(_listener) {
          return () => {};
        },
      },
      snapshot() {
        return {
          instanceId: input.instanceId,
          driverKind: DRIVER_KIND,
          enabled: input.enabled,
          ...(apiKey ? {} : { error: { code: "invalid_credentials", message: `No ${config.apiKeyEnv} set` } }),
        };
      },
      generateText: async (prompt, options) => {
        const c = new UniversalLLMClient({
          baseUrl: config.url,
          apiKey,
          model: options?.model ?? MODELS.default,
          provider: "openrouter",
          headers: {
            "HTTP-Referer": "https://opensand.dev",
            "X-Title": "OpenSand",
          },
        });
        const { stream, getConsolidated } = await c.streamCompletion([{ role: "user", content: prompt }]);
        let text = "";
        for await (const delta of stream) {
          if (delta.content) text += delta.content;
        }
        options?.onUsage?.({
          model: options?.model ?? MODELS.default,
          input: prompt.length,
          output: text.length,
        });
        return text;
      },
      dispose() {
        return;
      },
    };

    return instance;
  },
};
