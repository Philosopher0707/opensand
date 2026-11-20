import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { providerRegistry, ProviderRegistry } from "../src/provider-registry.js";
import { OpenRouterDriver } from "../src/providers/openrouter-driver.js";
import { AnthropicDriver } from "../src/providers/anthropic-driver.js";
import { ClaudeDriver } from "../src/providers/claude-driver.js";
import { CodexDriver } from "../src/providers/codex-driver.js";
import { OpenCodeDriver } from "../src/providers/opencode-driver.js";
import { AntigravityDriver } from "../src/providers/antigravity-driver.js";

const BUILT_INS = {
  openrouter: OpenRouterDriver,
  anthropic: AnthropicDriver,
  "claude-code": ClaudeDriver,
  codex: CodexDriver,
  opencode: OpenCodeDriver,
  antigravity: AntigravityDriver,
};

describe("ProviderRegistry", () => {
  it("singleton has all six built-in drivers registered", () => {
    const kinds = providerRegistry.listDrivers();
    for (const kind of Object.keys(BUILT_INS)) assert.ok(kinds.includes(kind), `missing ${kind}`);
  });

  it("getDriver / hasDriver resolve every built-in driver", () => {
    for (const [kind, driver] of Object.entries(BUILT_INS)) {
      assert.equal(providerRegistry.getDriver(kind), driver);
      assert.equal(providerRegistry.hasDriver(kind), true);
    }
    assert.equal(providerRegistry.getDriver("nonexistent"), undefined);
    assert.equal(providerRegistry.hasDriver("nonexistent"), false);
  });

  it("creates an instance from an InstanceConfig using the driver's decodeConfig", async () => {
    const { instance, config } = await providerRegistry.createInstance(
      "anthropic-reg-1",
      {
        driver: "anthropic",
        displayName: "Registry Anthropic",
        enabled: true,
        config: { url: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_TEST_KEY" },
      }
    );

    assert.equal(instance.instanceId, "anthropic-reg-1");
    assert.equal(instance.driverKind, "anthropic");
    assert.equal(instance.displayName, "Registry Anthropic");
    assert.equal(instance.enabled, true);
    assert.deepEqual(config, { url: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_TEST_KEY" });
    await instance.dispose();
  });

  it("passes environment through to the created instance", async () => {
    const { instance } = await providerRegistry.createInstance("or-reg", {
      driver: "openrouter",
      displayName: "Registry OpenRouter",
      enabled: true,
      environment: { OPENROUTER_REG_KEY: "key" },
      config: { apiKeyEnv: "OPENROUTER_REG_KEY" },
    });
    assert.equal((await instance.snapshot()).error, undefined);
    await instance.dispose();
  });

  it("tracks, fetches and lists live instances", async () => {
    await providerRegistry.createInstance("anthropic-reg-2", {
      driver: "anthropic",
      displayName: "A2",
      enabled: true,
      config: {},
    });
    await providerRegistry.createInstance("codex-reg-1", {
      driver: "codex",
      displayName: "C1",
      enabled: true,
      config: {},
    });

    const instances = providerRegistry.listInstances();
    assert.ok(instances.some((i) => i.instanceId === "anthropic-reg-2"));
    assert.ok(instances.some((i) => i.instanceId === "codex-reg-1"));
    assert.equal(providerRegistry.getInstance("anthropic-reg-2")?.instanceId, "anthropic-reg-2");
    await providerRegistry.disposeAll();
    assert.equal(providerRegistry.listInstances().length, 0);
  });

  it("disposeInstance removes an instance and returns false for unknown ids", async () => {
    const { instance } = await providerRegistry.createInstance("anthropic-reg-3", {
      driver: "anthropic",
      displayName: "A3",
      enabled: true,
      config: {},
    });
    assert.equal(await providerRegistry.disposeInstance("anthropic-reg-3"), true);
    assert.equal(providerRegistry.getInstance("anthropic-reg-3"), undefined);
    assert.equal(await providerRegistry.disposeInstance("nonexistent-id"), false);
  });

  it("throws for an unknown driver kind and propagates config validation errors", async () => {
    await assert.rejects(
      providerRegistry.createInstance("bad-driver", {
        driver: "nonexistent-driver" as string,
        displayName: "Bad",
        enabled: true,
        config: {},
      }),
      /Unknown provider driver/
    );
    await assert.rejects(
      providerRegistry.createInstance("bad-config", {
        driver: "anthropic",
        displayName: "Bad",
        enabled: true,
        config: { url: 42 },
      }),
      /url must be a string/
    );
  });

  it("a fresh registry starts empty and can register drivers explicitly", async () => {
    const fresh = new ProviderRegistry();
    assert.equal(fresh.listDrivers().length, 0);
    assert.equal(fresh.getDriver("anthropic"), undefined);
    fresh.register(AnthropicDriver, AnthropicDriver);
    assert.deepEqual(fresh.listDrivers(), ["anthropic"]);
    const { instance } = await fresh.createInstance("fresh-1", {
      driver: "anthropic",
      displayName: "Fresh",
      enabled: true,
      config: {},
    });
    await instance.dispose();
    await fresh.disposeAll();
  });
});
