import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { CodexDriver } from "../src/providers/codex-driver.ts";

describe("CodexDriver - Grok Bot drivers/codex.ts parity", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-codex-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("decodes config with defaults", () => {
    const config = CodexDriver.decodeConfig({});
    assert.equal(config.cli, "codex");
    assert.equal(config.fullAuto, false);
    assert.equal(config.authMode, undefined);
  });

  it("decodes config with custom values", () => {
    const config = CodexDriver.decodeConfig({
      cli: "/usr/local/bin/codex",
      fullAuto: true,
      authMode: "chatgpt-plan",
    });
    assert.equal(config.cli, "/usr/local/bin/codex");
    assert.equal(config.fullAuto, true);
    assert.equal(config.authMode, "chatgpt-plan");
  });

  it("defaultConfig returns decodeConfig({})", () => {
    const d1 = CodexDriver.defaultConfig();
    const d2 = CodexDriver.decodeConfig({});
    assert.deepEqual(d1, d2);
  });

  it("exposes model catalog", () => {
    assert.equal(CodexDriver.models.default, "codex-mini-latest");
    assert.ok(Array.isArray(CodexDriver.models.options));
    assert.ok(CodexDriver.models.options.length > 0);
    assert.ok(CodexDriver.models.options.some((m) => m.id === "codex-mini-latest"));
    assert.ok(CodexDriver.models.options.some((m) => m.id === "o3"));
    assert.ok(CodexDriver.models.options.some((m) => m.id === "gpt-4.1"));
  });

  it("metadata identifies driver as Codex", () => {
    assert.equal(CodexDriver.driverKind, "codex");
    assert.equal(CodexDriver.metadata.displayName, "Codex");
    assert.equal(CodexDriver.metadata.access, "custom");
  });

  it("create returns an instance with expected shape", async () => {
    const instance = await CodexDriver.create({
      instanceId: "codex-1",
      displayName: "Codex Test",
      environment: {},
      enabled: true,
      config: CodexDriver.decodeConfig({ cli: "codex", fullAuto: true }),
    });

    assert.equal(instance.instanceId, "codex-1");
    assert.equal(instance.driverKind, "codex");
    assert.equal(instance.displayName, "Codex Test");
    assert.equal(instance.enabled, true);
    assert.equal(instance.models.default, "codex-mini-latest");

    const snap = await instance.snapshot();
    assert.equal(snap.instanceId, "codex-1");
    assert.equal(snap.driverKind, "codex");
    assert.equal(snap.enabled, true);

    // adapter capabilities mirror OpenMausBot's Codex driver
    assert.equal(instance.adapter.provider, "codex");
    assert.ok(instance.adapter.capabilities.queueing === true);
    assert.ok(instance.adapter.capabilities.strictResume === true);
    assert.ok(instance.adapter.capabilities.agentsMcp === true);
    assert.ok(instance.adapter.capabilities.customMcp === true);
    assert.ok(instance.adapter.capabilities.computerMcp === true);
    assert.ok(instance.adapter.capabilities.composioMcp === true);

    await instance.stopAll();
    await instance.dispose();
  });

  it("refreshModels resolves without error", async () => {
    const instance = await CodexDriver.create({
      instanceId: "codex-2",
      displayName: "Refresh Test",
      environment: {},
      enabled: true,
      config: CodexDriver.decodeConfig({}),
    });
    await instance.refreshModels();
    await instance.dispose();
  });

  it("generateText throws when codex CLI is unavailable", async () => {
    const instance = await CodexDriver.create({
      instanceId: "codex-3",
      displayName: "Generate Test",
      environment: {},
      enabled: true,
      config: CodexDriver.decodeConfig({}),
    });

    let threw = false;
    try {
      await instance.generateText("hello", { onUsage: () => {} });
    } catch {
      threw = true;
    }
    assert.ok(threw, "generateText should throw when codex CLI is unavailable");

    await instance.dispose();
  });
});
