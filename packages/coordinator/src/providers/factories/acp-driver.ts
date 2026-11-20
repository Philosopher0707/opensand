/** Factory for the thin, config-only ACP drivers (one per OpenMausBot AcpSupport). */

import type { EngineAccess, ModelCatalog, ProviderDriver } from "@opensand/shared";
import { createAcpInstance, type AcpConfig, type AcpRuntimeOptions } from "../runtime/acp-runtime.js";
import type { DeviceAuthSpec } from "../runtime/device-auth.js";

export interface AcpDriverSpec {
  driverKind: string;
  displayName: string;
  cli: string;
  spawnArgs: (config: AcpConfig) => string[];
  models: ModelCatalog;
  access?: EngineAccess;
  cliVersion?: RegExp;
  modelConfigId?: string;
  auth?: DeviceAuthSpec;
  configureSession?: AcpRuntimeOptions["configureSession"];
}

function decodeConfig(raw: unknown, defaultCli: string): AcpConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.cli !== undefined && typeof config.cli !== "string") throw new Error("cli must be a string");
  if (config.fullAuto !== undefined && typeof config.fullAuto !== "boolean") {
    throw new Error("fullAuto must be a boolean");
  }
  if (config.workspace !== undefined && typeof config.workspace !== "string") {
    throw new Error("workspace must be a string");
  }
  return {
    cli: typeof config.cli === "string" ? config.cli : defaultCli,
    fullAuto: config.fullAuto === true,
    ...(typeof config.workspace === "string" ? { workspace: config.workspace } : {}),
  };
}

/** Build a ProviderDriver whose protocol comes from the shared ACP runtime. */
export function defineAcpDriver(spec: AcpDriverSpec): ProviderDriver<AcpConfig> {
  return {
    driverKind: spec.driverKind,
    metadata: {
      displayName: spec.displayName,
      supportsMultipleInstances: true,
      access: spec.access ?? "custom",
      ...(spec.cliVersion ? { cliVersion: spec.cliVersion } : {}),
    },
    models: spec.models,
    decodeConfig: (raw) => decodeConfig(raw, spec.cli),
    defaultConfig: () => decodeConfig({}, spec.cli),
    create(input) {
      return Promise.resolve(
        createAcpInstance(input, {
          driverKind: spec.driverKind,
          displayName: spec.displayName,
          models: spec.models,
          clientName: "opensand",
          spawnArgs: spec.spawnArgs,
          ...(spec.modelConfigId ? { modelConfigId: spec.modelConfigId } : {}),
          ...(spec.auth ? { auth: spec.auth } : {}),
          ...(spec.configureSession ? { configureSession: spec.configureSession } : {}),
        })
      );
    },
  };
}
