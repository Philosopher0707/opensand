import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AnthropicDriver } from "../src/providers/anthropic-driver.js";

describe("AnthropicDriver", () => {
  it("decodes config with defaults", () => {
    const config = AnthropicDriver.decodeConfig({});
    assert.equal(config.url, "https://api.anthropic.com/v1");
    assert.equal(config.apiKeyEnv, "ANTHROPIC_API_KEY");
  });

  it("decodes config with custom values and ignores unknown keys", () => {
    const config = AnthropicDriver.decodeConfig({
      url: "https://custom.anthropic.example",
      apiKeyEnv: "MY_ANTHROPIC_KEY",
      apiKey: "ignored",
    });
    assert.equal(config.url, "https://custom.anthropic.example");
    assert.equal(config.apiKeyEnv, "MY_ANTHROPIC_KEY");
  });

  it("rejects invalid config types at the trust boundary", () => {
    assert.throws(() => AnthropicDriver.decodeConfig({ url: 42 }), /url must be a string/);
    assert.throws(() => AnthropicDriver.decodeConfig({ apiKeyEnv: 7 }), /apiKeyEnv must be a string/);
  });

  it("defaultConfig returns decodeConfig({})", () => {
    assert.deepEqual(AnthropicDriver.defaultConfig(), AnthropicDriver.decodeConfig({}));
  });

  it("exposes catalog and metadata", () => {
    assert.equal(AnthropicDriver.models.default, "claude-3-7-sonnet-20250219");
    assert.ok(AnthropicDriver.models.options.some((m) => m.id === "claude-3-haiku-20240307"));
    assert.equal(AnthropicDriver.driverKind, "anthropic");
    assert.equal(AnthropicDriver.metadata.displayName, "Anthropic (Claude)");
    assert.equal(AnthropicDriver.metadata.access, "api");
  });

  it("creates an instance with expected shape and reports a missing key", async () => {
    const instance = await AnthropicDriver.create({
      instanceId: "anthropic-1",
      displayName: "Anthropic Test",
      environment: {},
      enabled: true,
      config: AnthropicDriver.decodeConfig({ apiKeyEnv: "ANTHROPIC_TEST_KEY_ABSENT" }),
    });

    assert.equal(instance.instanceId, "anthropic-1");
    assert.equal(instance.driverKind, "anthropic");
    assert.equal(instance.displayName, "Anthropic Test");
    assert.equal(instance.enabled, true);
    assert.equal(instance.models.default, "claude-3-7-sonnet-20250219");
    assert.equal(instance.adapter.provider, "anthropic");
    assert.equal(instance.adapter.hasSession("thread-1"), false);
    assert.equal(instance.adapter.enginePid("thread-1"), undefined);

    const snap = await instance.snapshot();
    assert.equal(snap.instanceId, "anthropic-1");
    assert.equal(snap.driverKind, "anthropic");
    assert.equal(snap.error?.code, "invalid_credentials");

    await instance.refreshModels?.();
    await instance.adapter.stopAll();
    await instance.dispose();
  });

  it("emits text deltas and usage callbacks over a mock HTTP endpoint", async () => {
    // No network: a local HTTP server that speaks just enough OpenAI-compatible SSE.
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/v1`;

    try {
      const instance = await AnthropicDriver.create({
        instanceId: "anthropic-http",
        displayName: "HTTP Test",
        environment: { ANTHROPIC_TEST_KEY: "test-key" },
        enabled: true,
        config: AnthropicDriver.decodeConfig({ url, apiKeyEnv: "ANTHROPIC_TEST_KEY" }),
      });
      let usage: { input?: number; output?: number } | undefined;
      const events: unknown[] = [];
      instance.adapter.onEvent((e) => events.push(e));
      const generate = instance.generateText;
      assert.ok(generate, "API drivers must provide generateText");
      const text = await generate("hi", { onUsage: (u) => { usage = u; } });
      assert.equal(text, "hello");
      assert.equal(usage?.input, "hi".length);
      assert.equal(usage?.output, "hello".length);
      assert.ok(events.some((e) => (e as { type: string }).type === "text.delta"));
      await instance.dispose();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    }
  });
});
