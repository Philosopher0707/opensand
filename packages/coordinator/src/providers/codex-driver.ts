/**
 * Codex CLI driver over the app-server JSON-RPC protocol. The handshake,
 * approval handling and turn lifecycle live in the shared Codex runtime.
 */

import type { ModelCatalog, ProviderDriver } from "@opensand/shared";
import { createCodexInstance, type CodexConfig } from "./runtime/codex-runtime.js";

const DRIVER_KIND = "codex";
const DEFAULT_CLI = "codex";

const MODELS: ModelCatalog = {
  default: "codex-mini-latest",
  options: [
    { id: "codex-mini-latest", label: "Codex Mini Latest", contextWindow: 128_000 },
    { id: "o3", label: "o3", contextWindow: 200_000 },
    { id: "o4-mini", label: "o4 Mini", contextWindow: 200_000 },
    { id: "gpt-4.1", label: "GPT-4.1", contextWindow: 1_000_000 },
    { id: "gpt-4.1-mini", label: "GPT-4.1 Mini", contextWindow: 1_000_000 },
  ],
};

function decodeConfig(raw: unknown): CodexConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.cli !== undefined && typeof config.cli !== "string") throw new Error("cli must be a string");
  if (config.fullAuto !== undefined && typeof config.fullAuto !== "boolean") {
    throw new Error("fullAuto must be a boolean");
  }
  return {
    cli: typeof config.cli === "string" ? config.cli : DEFAULT_CLI,
    fullAuto: config.fullAuto === true,
    ...(config.authMode === "chatgpt-plan" ? { authMode: "chatgpt-plan" as const } : {}),
  };
}

export const CodexDriver: ProviderDriver<CodexConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
    access: "custom",
    cli: true,
    cliVersion: /v?(\d+)\.(\d+)\.(\d+)/,
  },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  create(input) {
    return Promise.resolve(
      createCodexInstance(input, {
        driverKind: DRIVER_KIND,
        displayName: "Codex",
        models: MODELS,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
      })
    );
  },
};
