/**
 * Claude Code CLI driver. The retained-process stream-json protocol lives in
 * the shared Claude runtime; this file validates config and declares the catalog.
 */

import type { ModelCatalog, ProviderDriver } from "@opensand/shared";
import { createClaudeInstance, type ClaudeConfig } from "./runtime/claude-runtime.js";

const DRIVER_KIND = "claude-code";
const DEFAULT_CLI = "claude";

const MODELS: ModelCatalog = {
  default: "claude-3-7-sonnet-20250219",
  options: [
    { id: "claude-3-7-sonnet-20250219", label: "Claude 3.7 Sonnet", contextWindow: 200_000 },
    { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet", contextWindow: 200_000 },
    { id: "claude-3-opus-20240229", label: "Claude 3 Opus", contextWindow: 200_000 },
    { id: "claude-3-haiku-20240307", label: "Claude 3 Haiku", contextWindow: 200_000 },
  ],
};

function decodeConfig(raw: unknown): ClaudeConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.cli !== undefined && typeof config.cli !== "string") throw new Error("cli must be a string");
  if (config.fullAuto !== undefined && typeof config.fullAuto !== "boolean") {
    throw new Error("fullAuto must be a boolean");
  }
  if (config.configDir !== undefined && typeof config.configDir !== "string") {
    throw new Error("configDir must be a string");
  }
  return {
    cli: typeof config.cli === "string" ? config.cli : DEFAULT_CLI,
    fullAuto: config.fullAuto === true,
    ...(typeof config.configDir === "string" ? { configDir: config.configDir } : {}),
  };
}

export const ClaudeDriver: ProviderDriver<ClaudeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude Code",
    supportsMultipleInstances: true,
    access: "custom",
    cliVersion: /^(\d+)\.(\d+)\.(\d+)/,
  },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  create(input) {
    return Promise.resolve(
      createClaudeInstance(input, {
        driverKind: DRIVER_KIND,
        displayName: "Claude Code",
        models: MODELS,
        effortLevels: ["low", "medium", "high"],
      })
    );
  },
};
