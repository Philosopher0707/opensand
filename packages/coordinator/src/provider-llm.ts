/**
 * Production bridge from the app's provider settings to the driver registry.
 *
 * The coordinator's turn loop needs a streaming LLM client with tool-call
 * support, so only API-backed drivers (which wrap UniversalLLMClient) can
 * serve it. CLI drivers stay reachable through ProviderRegistry for callers
 * that use ProviderAdapter.sendTurn directly.
 */

import { randomUUID } from "node:crypto";
import type { UniversalLLMClient } from "./llm-client.js";
import { providerRegistry } from "./provider-registry.js";
import type { ApiProviderInstance } from "./providers/runtime/api-chat-runtime.js";

export interface DriverLlmClientInput {
  provider: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  environment?: Record<string, string>;
}

/** Map the app's legacy provider names to registered driver kinds. */
export function driverKindForProvider(provider: string): string | null {
  switch (provider.toLowerCase()) {
    case "openrouter":
      return "openrouter";
    case "anthropic":
      return "anthropic";
    default:
      return null;
  }
}

/**
 * Build an LLM client through a registered provider driver.
 * Returns null when the selected provider has no API-backed driver, so the
 * caller can keep using the existing local/compatible client path.
 */
export async function createDriverLlmClient(input: DriverLlmClientInput): Promise<UniversalLLMClient | null> {
  const kind = providerRegistry.hasDriver(input.provider)
    ? input.provider
    : driverKindForProvider(input.provider);
  if (!kind) return null;

  const driver = providerRegistry.getDriver(kind);
  if (!driver) return null;

  const defaultConfig = driver.defaultConfig() as { apiKeyEnv?: string; url?: string };
  const apiKeyEnv = defaultConfig.apiKeyEnv;
  const environment = { ...(input.environment ?? {}) };
  if (apiKeyEnv && input.apiKey && input.apiKey !== "none") {
    environment[apiKeyEnv] = input.apiKey;
  }

  const instanceId = `llm:${kind}:${randomUUID()}`;
  const { instance } = await providerRegistry.createInstance(
    instanceId,
    {
      driver: kind,
      displayName: driver.metadata.displayName,
      enabled: true,
      environment,
      config: {
        ...(apiKeyEnv ? { apiKeyEnv } : {}),
        ...(input.endpoint ? { url: input.endpoint } : {}),
      },
    },
    environment
  );

  const apiInstance = instance as ApiProviderInstance;
  if (typeof apiInstance.createLlmClient !== "function") {
    // CLI-backed drivers cannot serve the tool loop; do not leave a dead instance behind.
    await providerRegistry.disposeInstance(instanceId);
    return null;
  }

  const client = apiInstance.createLlmClient(input.model);
  // The client owns its own transport; the registry instance is only a factory here.
  await providerRegistry.disposeInstance(instanceId);
  return client;
}
