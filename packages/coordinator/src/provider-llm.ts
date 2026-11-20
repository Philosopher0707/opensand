/**
 * Production bridge from the app's provider settings to the driver registry.
 *
 * API-backed drivers expose UniversalLLMClient directly (full tool-call loop).
 * CLI-backed drivers expose only text turns; they are adapted to the same
 * streaming contract so they are still selectable in chat, with the explicit
 * limitation that tool calls run inside the CLI process, not in the app loop.
 */

import { randomUUID } from "node:crypto";
import type { ChatMessage, ProviderInstance } from "@opensand/shared";
import type { LlmStreamClient, UniversalLLMClient } from "./llm-client.js";
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
    case "openai":
      return "openai-compat";
    default:
      return null;
  }
}

function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "text" in result) {
    const text = (result as { text: unknown }).text;
    return typeof text === "string" ? text : String(text ?? "");
  }
  return "";
}

/** Text-only adapter for CLI drivers that cannot serve the coordinator's tool loop. */
function createTextStreamShim(instance: ProviderInstance, model: string): LlmStreamClient {
  const threadId = `chat_${randomUUID()}`;
  return {
    model,
    async streamCompletion(messages: ChatMessage[], _tools, signal) {
      if (signal?.aborted) throw new Error("This operation was aborted");
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content ?? "")
        .join("\n\n");
      const transcript = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", text: m.content ?? "" }));
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const result = await instance.adapter.sendTurn({
        threadId,
        text: lastUser?.content ?? "",
        ...(system ? { system } : {}),
        transcript,
        model,
      });
      const content = extractText(result);
      return {
        stream: (async function* () {
          if (content) yield { content };
        })(),
        getConsolidated: () => ({ role: "assistant" as const, content }),
      };
    },
  };
}

/**
 * Build an LLM client through a registered provider driver.
 * Returns null only when no driver is registered for the selected provider.
 */
export async function createDriverLlmClient(input: DriverLlmClientInput): Promise<LlmStreamClient | null> {
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
  if (typeof apiInstance.createLlmClient === "function") {
    const client: UniversalLLMClient = apiInstance.createLlmClient(input.model);
    // The client owns its own transport; the registry instance is only a factory here.
    await providerRegistry.disposeInstance(instanceId);
    return client;
  }

  // CLI driver: keep the instance alive for the lifetime of the chat session.
  return createTextStreamShim(instance, input.model);
}
