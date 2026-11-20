/**
 * OpenCode / OpenCode-Go driver over ACP stdio (`opencode acp`). The shared ACP
 * runtime owns the initialize/session/prompt handshake and permission flow.
 */

import type { ModelCatalog, ProviderDriver } from "@opensand/shared";
import { createAcpInstance, type AcpConfig } from "./runtime/acp-runtime.js";

const DRIVER_KIND = "opencode";
const DEFAULT_CLI = "opencode";

const MODELS: ModelCatalog = {
  default: "opencode/auto",
  options: [
    { id: "opencode/auto", label: "OpenCode Auto", contextWindow: 128_000 },
    { id: "openrouter/auto", label: "OpenRouter Auto", contextWindow: 128_000 },
    { id: "anthropic/claude-3.7-sonnet", label: "Claude 3.7 Sonnet", contextWindow: 200_000 },
    { id: "openai/gpt-4o", label: "GPT-4o", contextWindow: 128_000 },
  ],
};

function decodeConfig(raw: unknown): AcpConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.cli !== undefined && typeof config.cli !== "string") throw new Error("cli must be a string");
  if (config.fullAuto !== undefined && typeof config.fullAuto !== "boolean") {
    throw new Error("fullAuto must be a boolean");
  }
  return {
    cli: typeof config.cli === "string" ? config.cli : DEFAULT_CLI,
    fullAuto: config.fullAuto === true,
  };
}

export const OpenCodeDriver: ProviderDriver<AcpConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenCode",
    supportsMultipleInstances: true,
    access: "custom",
    cliVersion: /^(\d+)\.(\d+)\.(\d+)/,
  },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  create(input) {
    return Promise.resolve(
      createAcpInstance(input, {
        driverKind: DRIVER_KIND,
        displayName: "OpenCode",
        models: MODELS,
        clientName: "opensand",
        spawnArgs: () => ["acp"],
        modelConfigId: "model",
      })
    );
  },
};
