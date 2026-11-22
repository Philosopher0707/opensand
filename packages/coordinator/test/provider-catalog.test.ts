import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createServer } from "node:http";
import { discoverProviderModels } from "../src/provider-catalog.js";
import { providerRegistry } from "../src/provider-registry.js";
import { defineAcpDriver } from "../src/providers/factories/acp-driver.js";
import { ClaudeDriver } from "../src/providers/claude-driver.js";
import { CodexDriver } from "../src/providers/codex-driver.js";
import { FAKE_ACP_MODELS, writeFakeCli } from "./helpers/fake-cli.js";

describe("provider model discovery", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-discovery-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("discovers API models from the selected endpoint and caches the result", { timeout: 20_000 }, async () => {
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      assert.equal(req.headers.authorization, "Bearer discovery-key");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [
        { id: "endpoint/gpt", name: "Endpoint GPT", context_length: 262_144 },
        { id: "endpoint/mini", name: "Endpoint Mini" },
      ] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    try {
      const first = await discoverProviderModels({
        provider: "grok", endpoint, apiKey: "discovery-key", force: true,
      });
      assert.ok(first);
      assert.equal(first.provider, "grok");
      assert.equal(first.endpoint, endpoint);
      assert.equal(first.source, "endpoint");
      assert.equal(first.unconfirmed, false);
      assert.equal(first.models.default, "endpoint/gpt");
      assert.equal(first.models.options[0]?.contextWindow, 262_144);

      const second = await discoverProviderModels({ provider: "grok", endpoint });
      assert.deepEqual(second, first);
      assert.equal(requests, 1, "cached discovery must not re-request the endpoint");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    }
  });

  it("discovers CLI models through the provider's ACP probe", { timeout: 20_000 }, async () => {
    const cli = await writeFakeCli(tmpDir, "discovery-acp", FAKE_ACP_MODELS);
    const driver = defineAcpDriver({
      driverKind: "discoveryAcp",
      displayName: "Discovery ACP",
      cli,
      spawnArgs: () => ["acp"],
      models: { default: "static/model", options: [{ id: "static/model", label: "Static" }] },
    });
    providerRegistry.register(driver);

    const result = await discoverProviderModels({ provider: "discoveryAcp", force: true });
    assert.ok(result);
    assert.equal(result.provider, "discoveryAcp");
    assert.equal(result.source, "cli");
    assert.equal(result.unconfirmed, false);
    assert.equal(result.models.default, "probed/model-2");
    assert.ok(result.models.options.some((m) => m.id === "probed/model-1"));
  });

  it("returns null for an unregistered provider", async () => {
    assert.equal(await discoverProviderModels({ provider: "not-a-provider", endpoint: "" }), null);
  });

  it("derives auth capability and CLI metadata from the driver definition", () => {
    const plain = defineAcpDriver({
      driverKind: "plainMetadataAcp",
      displayName: "Plain ACP",
      cli: "plain",
      spawnArgs: () => [],
      models: { default: "m", options: [{ id: "m", label: "M" }] },
    });
    const withAuth = defineAcpDriver({
      driverKind: "authMetadataAcp",
      displayName: "Auth ACP",
      cli: "auth",
      spawnArgs: () => [],
      models: { default: "m", options: [{ id: "m", label: "M" }] },
      auth: {
        provider: "authMetadataProbe",
        homeEnv: "AUTH_METADATA_HOME",
        homeDir: ".auth-metadata",
        loginArgs: ["login"],
        urlPattern: /https:\/\/\S+/,
        codePattern: /\b[A-Z0-9]{4,12}\b/,
        failureMessage: "Sign-in failed",
      },
    });
    assert.equal(plain.metadata.supportsAuthentication, false);
    assert.equal(plain.metadata.cli, true);
    assert.equal(withAuth.metadata.supportsAuthentication, true);
    assert.equal(withAuth.metadata.cli, true);
    assert.equal(ClaudeDriver.metadata.cli, true);
    assert.equal(CodexDriver.metadata.cli, true);
    assert.equal(ClaudeDriver.metadata.supportsAuthentication, undefined);
    assert.equal(CodexDriver.metadata.supportsAuthentication, undefined);
  });

  it("uses the driver's static catalog as an unconfirmed fallback when probing fails", { timeout: 20_000 }, async () => {
    const driver = defineAcpDriver({
      driverKind: "brokenDiscoveryAcp",
      displayName: "Broken ACP",
      cli: "/nonexistent/discovery-cli",
      spawnArgs: () => ["acp"],
      models: { default: "static/fallback", options: [{ id: "static/fallback", label: "Fallback" }] },
    });
    providerRegistry.register(driver);

    const result = await discoverProviderModels({ provider: "brokenDiscoveryAcp", force: true });
    assert.ok(result);
    assert.equal(result.source, "static");
    assert.equal(result.unconfirmed, true);
    assert.equal(result.models.default, "static/fallback");
  });
});
