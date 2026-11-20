/**
 * OpenRouter driver over the OpenAI-compatible chat-completions contract.
 * Uses the shared API chat runtime for retry, timeouts and usage accounting.
 */

import type { ModelCatalog, ProviderDriver } from "@opensand/shared";
import { createApiInstance, type ApiChatConfig } from "./runtime/api-chat-runtime.js";

const DRIVER_KIND = "openrouter";
const DEFAULT_URL = "https://openrouter.ai/api/v1";
const DEFAULT_KEY_ENV = "OPENROUTER_API_KEY";

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

const HEADERS = {
  "HTTP-Referer": "https://opensand.dev",
  "X-Title": "OpenSand",
};

function decodeConfig(raw: unknown): ApiChatConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.url !== undefined && typeof config.url !== "string") {
    throw new Error("url must be a string");
  }
  if (config.apiKeyEnv !== undefined && typeof config.apiKeyEnv !== "string") {
    throw new Error("apiKeyEnv must be a string");
  }
  return {
    url: typeof config.url === "string" ? config.url : DEFAULT_URL,
    apiKeyEnv: typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : DEFAULT_KEY_ENV,
  };
}

export const OpenRouterDriver: ProviderDriver<ApiChatConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenRouter",
    supportsMultipleInstances: true,
    access: "api",
  },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  create(input) {
    return Promise.resolve(
      createApiInstance(input, {
        driverKind: DRIVER_KIND,
        displayName: "OpenRouter",
        models: MODELS,
        provider: "openrouter",
        headers: HEADERS,
      })
    );
  },
};
