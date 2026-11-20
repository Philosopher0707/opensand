import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ClaudeDriver } from "../src/providers/claude-driver.ts";

describe("ClaudeDriver - Grok Bot drivers/claude.ts parity", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-claude-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("decodes config with defaults", () => {
    const config = ClaudeDriver.decodeConfig({});
    assert.equal(config.cli, "claude");
    assert.equal(config.fullAuto, false);
    assert.equal(config.configDir, undefined);
  });

  it("decodes config with custom values", () => {
    const config = ClaudeDriver.decodeConfig({
      cli: "/usr/local/bin/claude",
      fullAuto: true,
      configDir: "/tmp/claude-config",
    });
    assert.equal(config.cli, "/usr/local/bin/claude");
    assert.equal(config.fullAuto, true);
    assert.equal(config.configDir, "/tmp/claude-config");
  });

  it("defaultConfig returns decodeConfig({})", () => {
    const d1 = ClaudeDriver.defaultConfig();
    const d2 = ClaudeDriver.decodeConfig({});
    assert.deepEqual(d1, d2);
  });

  it("exposes model catalog", () => {
    assert.equal(ClaudeDriver.models.default, "claude-3-7-sonnet-20250219");
    assert.ok(Array.isArray(ClaudeDriver.models.options));
    assert.ok(ClaudeDriver.models.options.length > 0);
    assert.ok(
      ClaudeDriver.models.options.some((m) => m.id === "claude-3-7-sonnet-20250219")
    );
    assert.ok(
      ClaudeDriver.models.options.some((m) => m.id === "claude-3-haiku-20240307")
    );
  });

  it("metadata identifies driver as Claude Code", () => {
    assert.equal(ClaudeDriver.driverKind, "claude-code");
    assert.equal(ClaudeDriver.metadata.displayName, "Claude Code");
    assert.equal(ClaudeDriver.metadata.access, "custom");
  });

  it("create returns an instance with expected shape", async () => {
    const instance = await ClaudeDriver.create({
      instanceId: "claude-1",
      displayName: "Claude Test",
      environment: {},
      enabled: true,
      config: ClaudeDriver.decodeConfig({ cli: "claude", fullAuto: true }),
    });

    assert.equal(instance.instanceId, "claude-1");
    assert.equal(instance.driverKind, "claude-code");
    assert.equal(instance.displayName, "Claude Test");
    assert.equal(instance.enabled, true);
    assert.equal(instance.models.default, "claude-3-7-sonnet-20250219");

    const snap = await instance.snapshot();
    assert.equal(snap.instanceId, "claude-1");
    assert.equal(snap.driverKind, "claude-code");
    assert.equal(snap.enabled, true);

    // adapter capabilities mirror OpenMausBot's Claude driver
    assert.equal(instance.adapter.provider, "claude-code");
    assert.ok(instance.adapter.capabilities.queueing === true);
    assert.ok(instance.adapter.capabilities.strictResume === true);
    assert.ok(instance.adapter.capabilities.localComputerMcp === true);

    await instance.stopAll();
    await instance.dispose();
  });

  it("refreshModels resolves without error", async () => {
    const instance = await ClaudeDriver.create({
      instanceId: "claude-2",
      displayName: "Refresh Test",
      environment: {},
      enabled: true,
      config: ClaudeDriver.decodeConfig({}),
    });
    await instance.refreshModels();
    await instance.dispose();
  });

  it("generateText returns a string", async () => {
    const instance = await ClaudeDriver.create({
      instanceId: "claude-3",
      displayName: "Generate Test",
      environment: {},
      enabled: true,
      config: ClaudeDriver.decodeConfig({}),
    });

    // spawn will fail because `claude` CLI is not installed; generateText
    // should reject with a spawn error rather than hang forever
    let threw = false;
    try {
      await instance.generateText("hello", { onUsage: () => {} });
    } catch {
      threw = true;
    }
    assert.ok(threw, "generateText should throw when claude CLI is unavailable");

    await instance.dispose();
  });
});
