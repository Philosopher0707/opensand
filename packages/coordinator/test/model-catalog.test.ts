import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createServer } from "node:http";
import { OpenCodeDriver } from "../src/providers/opencode-driver.js";
import { CodexDriver } from "../src/providers/codex-driver.js";
import { GrokApiDriver } from "../src/providers/grok-api-driver.js";
import { FAKE_ACP_MODELS, FAKE_CODEX_MODELS, writeFakeCli } from "./helpers/fake-cli.js";

describe("dynamic model catalog probing", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-models-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("discovers ACP models from session/new configOptions", { timeout: 20_000 }, async () => {
    const cli = await writeFakeCli(tmpDir, "fake-acp-models", FAKE_ACP_MODELS);
    const instance = await OpenCodeDriver.create({
      instanceId: "models-acp",
      displayName: "ACP Models",
      environment: {},
      enabled: true,
      config: OpenCodeDriver.decodeConfig({ cli }),
    });
    assert.equal(instance.modelsUnconfirmed, false);
    await instance.refreshModels?.();
    assert.equal(instance.modelsUnconfirmed, false);
    assert.equal(instance.models.default, "probed/model-2");
    assert.ok(instance.models.options.some((m) => m.id === "probed/model-1" && m.label === "Model One"));
    await instance.dispose();
  });

  it("discovers Codex models from model/list", { timeout: 20_000 }, async () => {
    const cli = await writeFakeCli(tmpDir, "fake-codex-models", FAKE_CODEX_MODELS);
    const instance = await CodexDriver.create({
      instanceId: "models-codex",
      displayName: "Codex Models",
      environment: {},
      enabled: true,
      config: CodexDriver.decodeConfig({ cli }),
    });
    await instance.refreshModels?.();
    assert.equal(instance.modelsUnconfirmed, false);
    assert.equal(instance.models.default, "probed-o3");
    assert.ok(instance.models.options.some((m) => m.id === "probed-mini"));
    await instance.dispose();
  });

  it("discovers API models from /models", { timeout: 20_000 }, async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [
        { id: "probed/gpt", name: "Probed GPT", context_length: 128_000 },
        { id: "probed/other", name: "Probed Other" },
      ] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      const instance = await GrokApiDriver.create({
        instanceId: "models-api",
        displayName: "API Models",
        environment: { XAI_MODELS_KEY: "k" },
        enabled: true,
        config: GrokApiDriver.decodeConfig({
          url: `http://127.0.0.1:${address.port}/v1`,
          apiKeyEnv: "XAI_MODELS_KEY",
        }),
      });
      await instance.refreshModels?.();
      assert.equal(instance.modelsUnconfirmed, false);
      assert.equal(instance.models.default, "probed/gpt");
      assert.equal(instance.models.options[0]?.contextWindow, 128_000);
      await instance.dispose();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    }
  });

  it("keeps the static catalog and marks it unconfirmed when probing fails", async () => {
    const instance = await GrokApiDriver.create({
      instanceId: "models-fallback",
      displayName: "Fallback",
      environment: {},
      enabled: true,
      config: GrokApiDriver.decodeConfig({ url: "http://127.0.0.1:1/v1" }),
    });
    await instance.refreshModels?.();
    assert.equal(instance.modelsUnconfirmed, true);
    assert.equal(instance.models.default, "grok-4.7");
    await instance.dispose();
  });
});
