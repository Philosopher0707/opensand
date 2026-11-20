import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { AnthropicDriver } from "../src/providers/anthropic-driver.ts";

describe("AnthropicDriver - Grok Bot driver parity", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-anthropic-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("decodes config with defaults", () => {
    const config = AnthropicDriver.decodeConfig({});
    assert.equal(config.apiKey, "");
    assert.equal(config.baseUrl, "https://api.anthropic.com");
    assert.equal(config.timeoutMs, 120_000);
  });

  it("decodes config with custom values", () => {
    const config = AnthropicDriver.decodeConfig({
      apiKey: "sk-ant-test123",
      baseUrl: "https://custom.anthropic.example",
      timeoutMs: 60_000,
    });
    assert.equal(config.apiKey, "sk-ant-test123");
    assert.equal(config.baseUrl, "https://custom.anthropic.example");
    assert.equal(config.timeoutMs, 60_000);
  });

  it("defaultConfig returns decodeConfig({})", () => {
    const d1 = AnthropicDriver.defaultConfig();
    const d2 = AnthropicDriver.decodeConfig({});
    assert.deepEqual(d1, d2);
  });

  it("exposes model catalog with default and options", () => {
    assert.equal(AnthropicDriver.models.default, "claude-3-7-sonnet-20250219");
    assert.ok(Array.isArray(AnthropicDriver.models.options));
    assert.ok(AnthropicDriver.models.options.length > 0);
    assert.ok(
      AnthropicDriver.models.options.some((m) => m.id === "claude-3-7-sonnet-20250219")
    );
    assert.ok(
      AnthropicDriver.models.options.some((m) => m.id === "claude-3-haiku-20240307")
    );
  });

  it("metadata identifies driver as Anthropic", () => {
    assert.equal(AnthropicDriver.driverKind, "anthropic");
    assert.equal(AnthropicDriver.metadata.displayName, "Anthropic (Claude)");
    assert.equal(AnthropicDriver.metadata.access, "api-key");
  });

  it("create returns an instance with expected shape", async () => {
    const instance = await AnthropicDriver.create({
      instanceId: "anthropic-1",
      displayName: "Anthropic Test",
      environment: {},
      enabled: true,
      config: AnthropicDriver.decodeConfig({ apiKey: "sk-ant-test" }),
    });

    assert.equal(instance.instanceId, "anthropic-1");
    assert.equal(instance.driverKind, "anthropic");
    assert.equal(instance.displayName, "Anthropic Test");
    assert.equal(instance.enabled, true);
    assert.equal(instance.models.default, "claude-3-7-sonnet-20250219");

    const snap = await instance.snapshot();
    assert.equal(snap.instanceId, "anthropic-1");
    assert.equal(snap.driverKind, "anthropic");
    assert.equal(snap.enabled, true);

    await instance.dispose();
  });

  it("refreshModels resolves without error", async () => {
    const instance = await AnthropicDriver.create({
      instanceId: "anthropic-2",
      displayName: "Refresh Test",
      environment: {},
      enabled: true,
      config: AnthropicDriver.decodeConfig({ apiKey: "sk-ant-test" }),
    });
    await instance.refreshModels();
    await instance.dispose();
  });
});
