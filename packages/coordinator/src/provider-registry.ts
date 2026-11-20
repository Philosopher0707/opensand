/**
 * ProviderRegistry — manages ProviderDriver lifecycle and instantiation,
 * matching OpenMausBot's BUILT_IN_DRIVERS pattern.
 *
 * Drivers are registered statically; instances are created per agent and
 * cached by instanceId. Each instance owns its own ProviderAdapter and
 * state; the registry never shares state between instances.
 */

import type {
  AnyProviderDriver,
  DriverCreateInput,
  DriverKind,
  InstanceConfig,
  InstanceId,
  ProviderDriver,
  ProviderInstance,
} from "@opensand/shared";
import { OpenRouterDriver } from "./providers/openrouter-driver.ts";
import { AnthropicDriver } from "./providers/anthropic-driver.ts";
import { ClaudeDriver } from "./providers/claude-driver.ts";

/** A registered driver plus its resolved config type marker. */
export interface RegisteredDriver<Config = unknown> extends ProviderDriver<Config> {
  // Marker: config type is carried generically, erased at runtime.
}

/** Result of creating a provider instance. */
export interface CreateProviderInstanceResult {
  instance: ProviderInstance;
  config: unknown;
}

/**
 * ProviderRegistry holds all known drivers and creates ProviderInstances
 * from InstanceConfig entries. It is the OpenSand equivalent of
 * OpenMausBot's server/drivers/builtIn.ts + instance manager.
 */
export class ProviderRegistry {
  private readonly drivers = new Map<DriverKind, AnyProviderDriver>();
  private readonly instances = new Map<InstanceId, ProviderInstance>();

  /** Register one or more drivers. */
  register(...drivers: AnyProviderDriver[]): void {
    for (const d of drivers) {
      this.drivers.set(d.driverKind, d);
    }
  }

  /** List all registered driver kinds. */
  listDrivers(): DriverKind[] {
    return Array.from(this.drivers.keys());
  }

  /** Get a registered driver by kind, or undefined. */
  getDriver(kind: DriverKind): AnyProviderDriver | undefined {
    return this.drivers.get(kind);
  }

  /** Check whether a driver kind is registered. */
  hasDriver(kind: DriverKind): boolean {
    return this.drivers.has(kind);
  }

  /** Create a ProviderInstance from an InstanceConfig. Throws if driver unknown. */
  async createInstance(
    instanceId: InstanceId,
    config: InstanceConfig,
    environment: Record<string, string> = {}
  ): Promise<CreateProviderInstanceResult> {
    const driver = this.drivers.get(config.driver);
    if (!driver) {
      throw new Error(`Unknown provider driver: ${config.driver}`);
    }

    const parsedConfig = driver.decodeConfig(config.config ?? {});

    const input: DriverCreateInput<typeof parsedConfig> = {
      instanceId,
      displayName: config.displayName,
      environment,
      enabled: config.enabled ?? true,
      config: parsedConfig,
    };

    const instance = await driver.create(input);
    this.instances.set(instanceId, instance);

    return { instance, config: parsedConfig };
  }

  /** Get an existing provider instance by id. */
  getInstance(instanceId: InstanceId): ProviderInstance | undefined {
    return this.instances.get(instanceId);
  }

  /** List all live provider instances. */
  listInstances(): ProviderInstance[] {
    return Array.from(this.instances.values());
  }

  /** Dispose and remove an instance. */
  async disposeInstance(instanceId: InstanceId): Promise<boolean> {
    const instance = this.instances.get(instanceId);
    if (!instance) return false;
    try {
      await instance.dispose();
    } catch {
      // Dispose errors are non-fatal; remove regardless.
    }
    this.instances.delete(instanceId);
    return true;
  }

  /** Dispose all instances (e.g. on shutdown). */
  async disposeAll(): Promise<void> {
    const promises = Array.from(this.instances.keys()).map((id) =>
      this.disposeInstance(id)
    );
    await Promise.all(promises);
    this.instances.clear();
  }
}

/** Shared singleton registry used by the coordinator and desktop. */
export const providerRegistry = new ProviderRegistry();

// Register built-in drivers (OpenMausBot's BUILT_IN_DRIVERS parity).
providerRegistry.register(OpenRouterDriver, AnthropicDriver, ClaudeDriver);
