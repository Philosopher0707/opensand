import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { AntigravityDriver } from "../src/providers/antigravity-driver.ts";

describe("AntigravityDriver - Grok Bot drivers/antigravity.ts parity", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-antigravity-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("decodes config with defaults", () => {
    const config = AntigravityDriver.decodeConfig({});
    assert.equal(config.cli, "agy");
    assert.equal(config.fullAuto, false);
    assert.equal(config.workspace, undefined);
  });

  it("decodes config with custom values", () => {
    const config = AntigravityDriver.decodeConfig({
      cli: "/usr/local/bin/agy",
      fullAuto: true,
      workspace: "/tmp/antigravity-workspace",
    });
    assert.equal(config.cli, "/usr/local/bin/agy");
    assert.equal(config.fullAuto, true);
    assert.equal(config.workspace, "/tmp/antigravity-workspace");
  });

  it("defaultConfig returns decodeConfig({})", () => {
    const d1 = AntigravityDriver.defaultConfig();
    const d2 = AntigravityDriver.decodeConfig({});
    assert.deepEqual(d1, d2);
  });

  it("exposes model catalog", () => {
    assert.equal(AntigravityDriver.models.default, "gemini-3.8-flash");
    assert.ok(Array.isArray(AntigravityDriver.models.options));
    assert.ok(AntigravityDriver.models.options.length > 0);
    assert.ok(
      AntigravityDriver.models.options.some((m) => m.id === "gemini-3.8-flash")
    );
    assert.ok(
      AntigravityDriver.models.options.some((m) => m.id === "gemini-3.8-pro")
    );
  });

  it("metadata identifies driver as Antigravity", () => {
    assert.equal(AntigravityDriver.driverKind, "antigravity");
    assert.equal(AntigravityDriver.metadata.displayName, "Google Gemini (Antigravity)");
    assert.equal(AntigravityDriver.metadata.access, "custom");
  });

  it("create returns an instance with expected shape", async () => {
    const instance = await AntigravityDriver.create({
      instanceId: "antigravity-1",
      displayName: "Antigravity Test",
      environment: {},
      enabled: true,
      config: AntigravityDriver.decodeConfig({ cli: "agy", fullAuto: true }),
    });

    assert.equal(instance.instanceId, "antigravity-1");
    assert.equal(instance.driverKind, "antigravity");
    assert.equal(instance.displayName, "Antigravity Test");
    assert.equal(instance.enabled, true);
    assert.equal(instance.models.default, "gemini-3.8-flash");

    const snap = await instance.snapshot();
    assert.equal(snap.instanceId, "antigravity-1");
    assert.equal(snap.driverKind, "antigravity");
    assert.equal(snap.enabled, true);

    // adapter capabilities mirror OpenMausBot's Antigravity driver
    assert.equal(instance.adapter.provider, "antigravity");
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
    const instance = await AntigravityDriver.create({
      instanceId: "antigravity-2",
      displayName: "Refresh Test",
      environment: {},
      enabled: true,
      config: AntigravityDriver.decodeConfig({}),
    });
    await instance.refreshModels();
    await instance.dispose();
  });

  it("generateText throws when agy CLI is unavailable", async () => {
    const instance = await AntigravityDriver.create({
      instanceId: "antigravity-3",
      displayName: "Generate Test",
      environment: {},
      enabled: true,
      config: AntigravityDriver.decodeConfig({}),
    });

    let threw = false;
    try {
      await instance.generateText("hello", { onUsage: () => {} });
    } catch {
      threw = true;
    }
    assert.ok(threw, "generateText should throw when agy CLI is unavailable");

    await instance.dispose();
  });
});
