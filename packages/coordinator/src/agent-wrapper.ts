/**
 * AgentWrapper — binds an AgentRecord to a live ProviderInstance, mirroring
 * OpenMausBot's agents-bridge where each bot is wired to its provider
 * instance. The wrapper owns per-agent turn routing: it resolves the agent's
 * model/endpoint/approval mode and delegates to the provider adapter.
 */

import type {
  AgentRecord,
  ProviderInstance,
  ProviderSnapshot,
  SendTurnInput,
} from "@opensand/shared";

/** Resolved provider config for an agent, pulled from the record + env. */
export interface AgentProviderConfig {
  provider: string; // driverKind
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

/** The wrapper instance — one per agent. */
export interface AgentWrapper {
  readonly agentId: string;
  readonly providerInstance: ProviderInstance | undefined;
  readonly config: AgentProviderConfig;

  /** Refresh the bound provider instance (called after settings change). */
  refresh(): Promise<void>;

  /** Send a turn through the bound provider. */
  sendTurn(input: SendTurnInput): Promise<unknown>;

  /** Get the provider snapshot (enabled/key status/warnings). */
  snapshot(): Promise<ProviderSnapshot>;

  /** Dispose the bound provider instance. */
  dispose(): Promise<void>;
}

/** Options for creating an AgentWrapper. */
export interface AgentWrapperOptions {
  agent: AgentRecord;
  environment: Record<string, string>;
  registry: {
    getDriver(kind: string): { create(input: any): Promise<ProviderInstance> } | undefined;
    getInstance(id: string): ProviderInstance | undefined;
  };
}

/** Build the provider config from an AgentRecord. */
export function resolveAgentProviderConfig(agent: AgentRecord): AgentProviderConfig {
  const provider = agent.endpoint ? "openai-compat" : "openrouter";
  const baseUrl = agent.endpoint ?? "https://openrouter.ai/api/v1";
  const model = agent.model ?? "openrouter/auto";

  return {
    provider,
    baseUrl,
    apiKey: agent.openRouterApiKeyId ? `key_${agent.openRouterApiKeyId}` : undefined,
    model,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    topP: agent.topP,
  };
}

/** Create an AgentWrapper bound to a provider instance via the registry. */
export async function createAgentWrapper(
  options: AgentWrapperOptions
): Promise<AgentWrapper> {
  const { agent, environment, registry } = options;
  const config = resolveAgentProviderConfig(agent);

  let instance: ProviderInstance | undefined;

  // Try to reuse an existing instance by agent id, else create one.
  const existing = registry.getInstance(agent.id);
  if (existing) {
    instance = existing;
  } else {
    const driver = registry.getDriver(config.provider);
    if (driver) {
      instance = await driver.create({
        instanceId: agent.id,
        displayName: agent.name,
        environment,
        enabled: agent.enabled ?? false,
        config: {
          url: config.baseUrl,
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
      });
    }
  }

  const wrapper: AgentWrapper = {
    agentId: agent.id,
    get providerInstance() {
      return instance;
    },
    config,

    async refresh() {
      // Re-resolve config and rebind if provider/model changed.
      const next = resolveAgentProviderConfig(agent);
      if (next.provider !== config.provider || next.baseUrl !== config.baseUrl || next.model !== config.model) {
        if (instance) {
          try {
            await instance.dispose();
          } catch {
            // ignore
          }
        }
        const driver = registry.getDriver(next.provider);
        if (driver) {
          instance = await driver.create({
            instanceId: agent.id,
            displayName: agent.name,
            environment,
            enabled: agent.enabled ?? false,
            config: { url: next.baseUrl, apiKeyEnv: "OPENROUTER_API_KEY" },
          });
        } else {
          instance = undefined;
        }
      }
    },

    async sendTurn(input: SendTurnInput) {
      if (!instance) {
        throw new Error(`No provider instance for agent ${agent.id}`);
      }
      return instance.adapter.sendTurn(input);
    },

    async snapshot() {
      if (!instance) {
        return {
          instanceId: agent.id,
          driverKind: config.provider,
          enabled: agent.enabled ?? false,
          error: {
            code: "invalid_credentials" as const,
            message: "No provider instance bound",
          },
        };
      }
      return instance.snapshot();
    },

    async dispose() {
      if (instance) {
        try {
          await instance.dispose();
        } catch {
          // ignore
        }
        instance = undefined as any;
      }
    },
  };

  return wrapper;
}

/** Manager for all agent wrappers — one per active agent. */
export class AgentWrapperManager {
  private wrappers = new Map<string, AgentWrapper>();

  constructor(private readonly registry: AgentWrapperOptions["registry"]) {}

  /** Get or create a wrapper for an agent. */
  async getOrCreate(options: AgentWrapperOptions): Promise<AgentWrapper> {
    const existing = this.wrappers.get(options.agent.id);
    if (existing) {
      // Re-apply updated agent/environment.
      await existing.refresh();
      return existing;
    }

    const wrapper = await createAgentWrapper({ ...options, registry: this.registry });
    this.wrappers.set(options.agent.id, wrapper);
    return wrapper;
  }

  /** Get an existing wrapper without creating. */
  get(agentId: string): AgentWrapper | undefined {
    return this.wrappers.get(agentId);
  }

  /** Remove and dispose a wrapper. */
  async remove(agentId: string): Promise<boolean> {
    const wrapper = this.wrappers.get(agentId);
    if (!wrapper) return false;
    try {
      await wrapper.dispose();
    } catch {
      // ignore
    }
    this.wrappers.delete(agentId);
    return true;
  }

  /** List all active wrapper agent ids. */
  listAgentIds(): string[] {
    return Array.from(this.wrappers.keys());
  }

  /** Dispose all wrappers. */
  async disposeAll(): Promise<void> {
    const ids = this.listAgentIds();
    await Promise.all(ids.map((id) => this.remove(id)));
  }
}

/** Shared singleton manager used by the coordinator and desktop. */
export const agentWrapperManager = new AgentWrapperManager({
  getDriver: () => undefined,
  getInstance: () => undefined,
});
