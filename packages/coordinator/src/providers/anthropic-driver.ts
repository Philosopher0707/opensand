/**
 * Anthropic Messages API driver. Protocol, retry and timeout behavior lives in
 * the shared API chat runtime; this file only validates config and declares
 * the driver's static catalog.
 */

import type { ModelCatalog, ProviderDriver } from "@opensand/shared";
import { createApiInstance, type ApiChatConfig } from "./runtime/api-chat-runtime.js";

const DRIVER_KIND = "anthropic";
const DEFAULT_URL = "https://api.anthropic.com/v1";
const DEFAULT_KEY_ENV = "ANTHROPIC_API_KEY";

const MODELS: ModelCatalog = {
  default: "claude-3-7-sonnet-20250219",
  options: [
    { id: "claude-3-7-sonnet-20250219", label: "Claude 3.7 Sonnet", contextWindow: 200_000 },
    { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet", contextWindow: 200_000 },
    { id: "claude-3-opus-20240229", label: "Claude 3 Opus", contextWindow: 200_000 },
    { id: "claude-3-haiku-20240307", label: "Claude 3 Haiku", contextWindow: 200_000 },
  ],
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

export const AnthropicDriver: ProviderDriver<ApiChatConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Anthropic (Claude)",
    supportsMultipleInstances: true,
    access: "api",
  },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  create(input) {
    return Promise.resolve(
      createApiInstance({ ...input, config: input.config }, {
        driverKind: DRIVER_KIND,
        displayName: "Anthropic (Claude)",
        models: MODELS,
        provider: "anthropic",
      })
    );
  },
};
