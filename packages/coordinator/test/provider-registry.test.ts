import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  providerRegistry,
  ProviderRegistry,
} from "../src/provider-registry.ts";
import { AnthropicDriver } from "../src/providers/anthropic-driver.ts";
import { ClaudeDriver } from "../src/providers/claude-driver.ts";
import { CodexDriver } from "../src/providers/codex-driver.ts";
import { OpenCodeDriver } from "../src/providers/opencode-driver.ts";
import { AntigravityDriver } from "../src/providers/antigravity-driver.ts";

describe("ProviderRegistry - driver lifecycle and instance management", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-registry-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("singleton has all built-in drivers registered", () => {
    const kinds = providerRegistry.listDrivers();
    assert.ok(kinds.includes("anthropic"));
    assert.ok(kinds.includes("claude-code"));
    assert.ok(kinds.includes("codex"));
    assert.ok(kinds.includes("opencode"));
    assert.ok(kinds.includes("antigravity"));
  });

  it("getDriver returns the correct driver for each kind", () => {
    assert.equal(providerRegistry.getDriver("anthropic"), AnthropicDriver);
    assert.equal(providerRegistry.getDriver("claude-code"), ClaudeDriver);
    assert.equal(providerRegistry.getDriver("codex"), CodexDriver);
    assert.equal(providerRegistry.getDriver("opencode"), OpenCodeDriver);
    assert.equal(providerRegistry.getDriver("antigravity"), AntigravityDriver);
    assert.equal(providerRegistry.getDriver("nonexistent"), undefined);
  });

  it("hasDriver returns true for registered kinds", () => {
    assert.equal(providerRegistry.hasDriver("anthropic"), true);
    assert.equal(providerRegistry.hasDriver("nonexistent"), false);
  });

  it("creates an instance from an InstanceConfig", async () => {
    const { instance, config } = await providerRegistry.createInstance(
      "anthropic-reg-1",
      {
        driver: "anthropic",
        displayName: "Registry Anthropic",
        enabled: true,
        config: { apiKey: "sk-ant-test", baseUrl: "https://api.anthropic.com" },
      }
    );

    assert.equal(instance.instanceId, "anthropic-reg-1");
    assert.equal(instance.driverKind, "anthropic");
    assert.equal(instance.displayName, "Registry Anthropic");
    assert.equal(instance.enabled, true);
    assert.equal(instance.models.default, "claude-3-7-sonnet-20250219");

    assert.equal((config as { apiKey: string }).apiKey, "sk-ant-test");

    await instance.dispose();
  });

  it("getInstance returns the created instance", async () => {
    const { instance } = await providerRegistry.createInstance(
      "anthropic-reg-2",
      {
        driver: "anthropic",
        displayName: "Registry Anthropic 2",
        enabled: true,
        config: { apiKey: "sk-ant-test" },
      }
    );

    const fetched = providerRegistry.getInstance("anthropic-reg-2");
    assert.equal(fetched, instance);

    await instance.dispose();
  });

  it("listInstances returns all live instances", async () => {
    await providerRegistry.createInstance("anthropic-reg-3", {
      driver: "anthropic",
      displayName: "Registry Anthropic 3",
      enabled: true,
      config: { apiKey: "sk-ant-test" },
    });
    await providerRegistry.createInstance("claude-reg-1", {
      driver: "claude-code",
      displayName: "Registry Claude",
      enabled: true,
      config: { cli: "claude" },
    });

    const instances = providerRegistry.listInstances();
    assert.ok(instances.length >= 2);
    assert.ok(instances.some((i) => i.instanceId === "anthropic-reg-3"));
    assert.ok(instances.some((i) => i.instanceId === "claude-reg-1"));

    for (const inst of instances) {
      await inst.dispose();
    }
  });

  it("disposeInstance removes an instance", async () => {
    const { instance } = await providerRegistry.createInstance("anthropic-reg-4", {
      driver: "anthropic",
      displayName: "Registry Anthropic 4",
      enabled: true,
      config: { apiKey: "sk-ant-test" },
    });

    assert.equal(providerRegistry.getInstance("anthropic-reg-4"), instance);
    const disposed = await providerRegistry.disposeInstance("anthropic-reg-4");
    assert.equal(disposed, true);
    assert.equal(providerRegistry.getInstance("anthropic-reg-4"), undefined);
  });

  it("disposeInstance returns false for unknown id", async () => {
    const disposed = await providerRegistry.disposeInstance("nonexistent-id");
    assert.equal(disposed, false);
  });

  it("createInstance throws for unknown driver kind", async () => {
    let threw = false;
    try {
      await providerRegistry.createInstance("bad-driver", {
        driver: "nonexistent-driver" as any,
        displayName: "Bad",
        enabled: true,
        config: {},
      });
    } catch {
      threw = true;
    }
    assert.ok(threw, "createInstance should throw for unknown driver kind");
  });

  it("disposeAll clears all instances", async () => {
    await providerRegistry.createInstance("anthropic-reg-5", {
      driver: "anthropic",
      displayName: "Registry Anthropic 5",
      enabled: true,
      config: { apiKey: "sk-ant-test" },
    });
    assert.ok(providerRegistry.listInstances().length > 0);

    await providerRegistry.disposeAll();
    assert.equal(providerRegistry.listInstances().length, 0);
  });

  it("a fresh ProviderRegistry instance starts empty", () => {
    const fresh = new ProviderRegistry();
    assert.equal(fresh.listDrivers().length, 0);
    assert.equal(fresh.getDriver("anthropic"), undefined);
    assert.equal(fresh.listInstances().length, 0);
  });
});
