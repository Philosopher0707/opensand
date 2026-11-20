import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { OpenCodeDriver } from "../src/providers/opencode-driver.ts";

describe("OpenCodeDriver - Grok Bot drivers/acp/opencode-go.ts parity", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-opencode-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("decodes config with defaults", () => {
    const config = OpenCodeDriver.decodeConfig({});
    assert.equal(config.cli, "opencode");
    assert.equal(config.fullAuto, false);
  });

  it("decodes config with custom values", () => {
    const config = OpenCodeDriver.decodeConfig({
      cli: "/usr/local/bin/opencode",
      fullAuto: true,
    });
    assert.equal(config.cli, "/usr/local/bin/opencode");
    assert.equal(config.fullAuto, true);
  });

  it("defaultConfig returns decodeConfig({})", () => {
    const d1 = OpenCodeDriver.defaultConfig();
    const d2 = OpenCodeDriver.decodeConfig({});
    assert.deepEqual(d1, d2);
  });

  it("exposes model catalog", () => {
    assert.equal(OpenCodeDriver.models.default, "opencode/auto");
    assert.ok(Array.isArray(OpenCodeDriver.models.options));
    assert.ok(OpenCodeDriver.models.options.length > 0);
    assert.ok(OpenCodeDriver.models.options.some((m) => m.id === "opencode/auto"));
    assert.ok(OpenCodeDriver.models.options.some((m) => m.id === "openrouter/auto"));
  });

  it("metadata identifies driver as OpenCode", () => {
    assert.equal(OpenCodeDriver.driverKind, "opencode");
    assert.equal(OpenCodeDriver.metadata.displayName, "OpenCode");
    assert.equal(OpenCodeDriver.metadata.access, "custom");
  });

  it("create returns an instance with expected shape", async () => {
    const instance = await OpenCodeDriver.create({
      instanceId: "opencode-1",
      displayName: "OpenCode Test",
      environment: {},
      enabled: true,
      config: OpenCodeDriver.decodeConfig({ cli: "opencode", fullAuto: true }),
    });

    assert.equal(instance.instanceId, "opencode-1");
    assert.equal(instance.driverKind, "opencode");
    assert.equal(instance.displayName, "OpenCode Test");
    assert.equal(instance.enabled, true);
    assert.equal(instance.models.default, "opencode/auto");

    const snap = instance.snapshot();
    assert.equal(snap.instanceId, "opencode-1");
    assert.equal(snap.driverKind, "opencode");
    assert.equal(snap.enabled, true);

    // adapter capabilities mirror OpenMausBot's opencode-go driver
    assert.equal(instance.adapter.provider, "opencode");
    assert.ok(instance.adapter.capabilities.queueing === true);
    assert.ok(instance.adapter.capabilities.strictResume === true);
    assert.ok(instance.adapter.capabilities.localComputerMcp === true);
    assert.ok(instance.adapter.capabilities.agentsMcp === true);
    assert.ok(instance.adapter.capabilities.customMcp === true);
    assert.ok(instance.adapter.capabilities.computerMcp === true);
    assert.ok(instance.adapter.capabilities.composioMcp === true);

    await instance.stopAll();
    await instance.dispose();
  });

  it("refreshModels resolves without error", async () => {
    const instance = await OpenCodeDriver.create({
      instanceId: "opencode-2",
      displayName: "Refresh Test",
      environment: {},
      enabled: true,
      config: OpenCodeDriver.decodeConfig({}),
    });
    await instance.refreshModels();
    await instance.dispose();
  });

  it("generateText throws when opencode CLI is unavailable", async () => {
    const instance = await OpenCodeDriver.create({
      instanceId: "opencode-3",
      displayName: "Generate Test",
      environment: {},
      enabled: true,
      config: OpenCodeDriver.decodeConfig({}),
    });

    let threw = false;
    try {
      await instance.generateText("hello", { onUsage: () => {} });
    } catch {
      threw = true;
    }
    assert.ok(threw, "generateText should throw when opencode CLI is unavailable");

    await instance.dispose();
  });
});
