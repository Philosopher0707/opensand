/**
 * Driver-backed model discovery for the settings UI.
 *
 * Uses the registered driver's own refreshModels() (API /models, ACP config
 * options, Codex model/list), falls back to the driver's static catalog and
 * reports whether the list was confirmed. Results are cached by provider and
 * endpoint so opening settings does not re-probe a CLI on every change.
 */

import { randomUUID } from "node:crypto";
import type { ModelCatalog } from "@opensand/shared";
import { providerRegistry } from "./provider-registry.js";
import { driverKindForProvider } from "./provider-llm.js";

export interface ProviderModelDiscoveryInput {
  provider: string;
  endpoint?: string;
  apiKey?: string;
  environment?: Record<string, string>;
  force?: boolean;
}

export interface ProviderModelDiscoveryResult {
  provider: string;
  endpoint: string;
  models: ModelCatalog;
  unconfirmed: boolean;
  source: "endpoint" | "cli" | "static";
}

const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  result: ProviderModelDiscoveryResult;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ProviderModelDiscoveryResult | null>>();

function cacheKey(kind: string, endpoint: string): string {
  return `${kind}|${endpoint}`;
}

/** Discover the models a selected provider can actually use. */
export async function discoverProviderModels(
  input: ProviderModelDiscoveryInput
): Promise<ProviderModelDiscoveryResult | null> {
  const kind = providerRegistry.hasDriver(input.provider)
    ? input.provider
    : driverKindForProvider(input.provider);
  const driver = kind ? providerRegistry.getDriver(kind) : undefined;
  if (!kind || !driver) return null;

  const defaults = driver.defaultConfig() as { url?: string; apiKeyEnv?: string };
  const endpoint = input.endpoint ?? defaults.url ?? "";
  const key = cacheKey(kind, endpoint);

  if (!input.force) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
    const pending = inFlight.get(key);
    if (pending) return pending;
  }

  const task = (async (): Promise<ProviderModelDiscoveryResult | null> => {
    const apiKeyEnv = defaults.apiKeyEnv;
    const environment = { ...(input.environment ?? {}) };
    if (apiKeyEnv && input.apiKey && input.apiKey !== "none") environment[apiKeyEnv] = input.apiKey;

    const instanceId = `catalog:${kind}:${randomUUID()}`;
    try {
      const { instance } = await providerRegistry.createInstance(
        instanceId,
        {
          driver: kind,
          displayName: driver.metadata.displayName,
          enabled: true,
          environment,
          config: {
            ...(apiKeyEnv ? { apiKeyEnv } : {}),
            ...(endpoint ? { url: endpoint } : {}),
          },
        },
        environment
      );
      try {
        await instance.refreshModels?.();
        const unconfirmed = instance.modelsUnconfirmed ?? false;
        const result: ProviderModelDiscoveryResult = {
          provider: kind,
          endpoint,
          models: instance.models,
          unconfirmed,
          source: unconfirmed ? "static" : driver.metadata.access === "api" ? "endpoint" : "cli",
        };
        cache.set(key, { result, at: Date.now() });
        return result;
      } finally {
        await instance.adapter.stopAll();
        await instance.dispose();
      }
    } catch {
      const result: ProviderModelDiscoveryResult = {
        provider: kind,
        endpoint,
        models: driver.models,
        unconfirmed: true,
        source: "static",
      };
      cache.set(key, { result, at: Date.now() });
      return result;
    }
  })();

  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}

/** Clear cached catalogs (e.g. after settings change). */
export function clearProviderModelCache(): void {
  cache.clear();
}
