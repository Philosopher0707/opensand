/**
 * Google Antigravity (Gemini) driver over its ACP stdio server. Uses the shared
 * ACP runtime and applies Antigravity's session-scoped permission mode.
 */

import type { ModelCatalog, ProviderDriver, SendTurnInput } from "@opensand/shared";
import { createAcpInstance, type AcpConfig } from "./runtime/acp-runtime.js";

const DRIVER_KIND = "antigravity";
const DEFAULT_CLI = "agy";

const MODELS: ModelCatalog = {
  default: "gemini-3.8-flash",
  options: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", contextWindow: 1_000_000 },
    { id: "gemini-3.8-pro", label: "Gemini 3.8 Pro", contextWindow: 1_000_000 },
  ],
};

function decodeConfig(raw: unknown): AcpConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.cli !== undefined && typeof config.cli !== "string") throw new Error("cli must be a string");
  if (config.fullAuto !== undefined && typeof config.fullAuto !== "boolean") {
    throw new Error("fullAuto must be a boolean");
  }
  if (config.workspace !== undefined && typeof config.workspace !== "string") {
    throw new Error("workspace must be a string");
  }
  return {
    cli: typeof config.cli === "string" ? config.cli : DEFAULT_CLI,
    fullAuto: config.fullAuto === true,
    ...(typeof config.workspace === "string" ? { workspace: config.workspace } : {}),
  };
}

function permissionMode(turn: SendTurnInput, fullAuto: boolean): "yolo" | "auto_edit" | "default" {
  if (fullAuto || turn.approvalMode === "full") return "yolo";
  if (turn.approvalMode === "edits") return "auto_edit";
  return "default";
}

export const AntigravityDriver: ProviderDriver<AcpConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Google Gemini (Antigravity)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  create(input) {
    return Promise.resolve(
      createAcpInstance(input, {
        driverKind: DRIVER_KIND,
        displayName: "Google Gemini (Antigravity)",
        models: MODELS,
        clientName: "opensand",
        spawnArgs: () => [],
        configureSession: async (request, sessionId, turn, config) => {
          const wanted = permissionMode(turn, config.fullAuto);
          const result = await request("session/set_config_option", {
            sessionId,
            configId: "mode",
            value: wanted,
          });
          const applied = (result as { configOptions?: Array<{ id?: string; currentValue?: string }> } | undefined)
            ?.configOptions?.find((option) => option.id === "mode")?.currentValue;
          if (applied !== undefined && applied !== wanted) {
            throw new Error(`Antigravity did not apply ${wanted} permission mode`);
          }
        },
      })
    );
  },
};
