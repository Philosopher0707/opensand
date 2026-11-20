/** Factory for the thin, config-only API-key drivers. */

import type { EngineAccess, ModelCatalog, ProviderDriver } from "@opensand/shared";
import { createApiInstance, type ApiChatConfig } from "../runtime/api-chat-runtime.js";

export interface ApiDriverSpec {
  driverKind: string;
  displayName: string;
  url: string;
  apiKeyEnv: string;
  models: ModelCatalog;
  access?: EngineAccess;
  headers?: Record<string, string>;
  /** OpenAI-compatible APIs use "openrouter" transport; Anthropic-style uses "anthropic". */
  style?: "openrouter" | "anthropic";
}

function decodeConfig(raw: unknown, spec: ApiDriverSpec): ApiChatConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.url !== undefined && typeof config.url !== "string") throw new Error("url must be a string");
  if (config.apiKeyEnv !== undefined && typeof config.apiKeyEnv !== "string") {
    throw new Error("apiKeyEnv must be a string");
  }
  return {
    url: typeof config.url === "string" ? config.url : spec.url,
    apiKeyEnv: typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : spec.apiKeyEnv,
  };
}

/** Build a ProviderDriver whose HTTP transport comes from the shared API runtime. */
export function defineApiDriver(spec: ApiDriverSpec): ProviderDriver<ApiChatConfig> {
  return {
    driverKind: spec.driverKind,
    metadata: {
      displayName: spec.displayName,
      supportsMultipleInstances: true,
      access: spec.access ?? "api",
    },
    models: spec.models,
    decodeConfig: (raw) => decodeConfig(raw, spec),
    defaultConfig: () => decodeConfig({}, spec),
    create(input) {
      return Promise.resolve(
        createApiInstance(input, {
          driverKind: spec.driverKind,
          displayName: spec.displayName,
          models: spec.models,
          provider: spec.style ?? "openrouter",
          ...(spec.headers ? { headers: spec.headers } : {}),
        })
      );
    },
  };
}
