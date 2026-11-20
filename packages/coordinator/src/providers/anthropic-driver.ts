/**
 * Anthropic / Claude provider driver — API-key driver over the Anthropic Messages API.
 * No local binary; config is base URL + API key env name. Mirrors OpenMausBot's
 * drivers/grok.ts pattern (OpenAI-compatible API-key driver), adapted for Anthropic.
 */

import { UniversalLLMClient } from "../llm-client.js";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  SendTurnInput,
  TextGenerationOptions,
  TextGenerationUsage,
} from "@opensand/shared";

const DRIVER_KIND = "anthropic";
const DEFAULT_URL = "https://api.anthropic.com/v1";

const MODELS: ModelCatalog = {
  default: "claude-3-7-sonnet-20250219",
  options: [
    { id: "claude-3-7-sonnet-20250219", label: "Claude 3.7 Sonnet", contextWindow: 200_000 },
    { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet", contextWindow: 200_000 },
    { id: "claude-3-opus-20240229", label: "Claude 3 Opus", contextWindow: 200_000 },
    { id: "claude-3-haiku-20240307", label: "Claude 3 Haiku", contextWindow: 200_000 },
  ],
};

export interface AnthropicConfig {
  url: string;
  apiKeyEnv: string;
}

function decodeConfig(raw: unknown): AnthropicConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  return {
    url: typeof config.url === "string" ? config.url : DEFAULT_URL,
    apiKeyEnv: typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : "ANTHROPIC_API_KEY",
  };
}

export const AnthropicDriver: ProviderDriver<AnthropicConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Anthropic (Claude)",
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
      provider: "anthropic",
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
        models = MODELS;
      },
      snapshot(): ProviderSnapshot {
        return {
          instanceId: input.instanceId,
          driverKind: DRIVER_KIND,
          enabled: input.enabled,
          ...(apiKey
            ? {}
            : { error: { code: "invalid_credentials" as const, message: `No ${config.apiKeyEnv} set` } }),
        };
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
          const c = new UniversalLLMClient({
            baseUrl: config.url,
            apiKey,
            model: turn.model ?? MODELS.default,
            provider: "anthropic",
          });
          const messages = turn.transcript
            ? turn.transcript.map((t) => ({ role: t.role, content: t.text }))
            : [{ role: "user", content: turn.text }];
          if (turn.system) {
            messages.unshift({ role: "system", content: turn.system });
          }
          const { stream, getConsolidated } = await c.streamCompletion(messages);
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
      generateText: async (prompt, options) => {
        const c = new UniversalLLMClient({
          baseUrl: config.url,
          apiKey,
          model: options?.model ?? MODELS.default,
          provider: "anthropic",
        });
        const { stream, getConsolidated } = await c.streamCompletion([{ role: "user", content: prompt }]);
        let text = "";
        for await (const delta of stream) {
          if (delta.content) text += delta.content;
        }
        const usage: TextGenerationUsage = {
          model: options?.model ?? MODELS.default,
          input: prompt.length,
          output: text.length,
        };
        options?.onUsage?.(usage);
        return text;
      },
      dispose() {
        return;
      },
    };

    return instance;
  },
};
