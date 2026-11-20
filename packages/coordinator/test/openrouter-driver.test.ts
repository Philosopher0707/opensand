import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OpenRouterDriver } from "../src/providers/openrouter-driver.js";

describe("OpenRouterDriver", () => {
  it("decodes config with defaults and ignores unknown keys", () => {
    const config = OpenRouterDriver.decodeConfig({ apiKey: "ignored" });
    assert.equal(config.url, "https://openrouter.ai/api/v1");
    assert.equal(config.apiKeyEnv, "OPENROUTER_API_KEY");
  });

  it("decodes custom values and rejects invalid types", () => {
    assert.deepEqual(OpenRouterDriver.decodeConfig({ url: "https://proxy.local/v1", apiKeyEnv: "KEY" }), {
      url: "https://proxy.local/v1",
      apiKeyEnv: "KEY",
    });
    assert.throws(() => OpenRouterDriver.decodeConfig({ url: 1 }), /url must be a string/);
    assert.throws(() => OpenRouterDriver.decodeConfig({ apiKeyEnv: false }), /apiKeyEnv must be a string/);
  });

  it("exposes catalog and metadata", () => {
    assert.equal(OpenRouterDriver.driverKind, "openrouter");
    assert.equal(OpenRouterDriver.metadata.access, "api");
    assert.equal(OpenRouterDriver.models.default, "openrouter/auto");
    assert.ok(OpenRouterDriver.models.options.some((m) => m.id === "x-ai/grok-4"));
  });

  it("reports no error when a key is present in the environment", async () => {
    const instance = await OpenRouterDriver.create({
      instanceId: "or-1",
      displayName: "OpenRouter Test",
      environment: { OPENROUTER_TEST_KEY: "test-key" },
      enabled: true,
      config: OpenRouterDriver.decodeConfig({ apiKeyEnv: "OPENROUTER_TEST_KEY" }),
    });
    const snap = await instance.snapshot();
    assert.equal(snap.error, undefined);
    await instance.dispose();
  });

  it("streams a turn over an OpenAI-compatible endpoint", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        assert.ok(body.includes("openrouter/auto"));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"world"},"finish_reason":null}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    try {
      const instance = await OpenRouterDriver.create({
        instanceId: "or-http",
        displayName: "HTTP Test",
        environment: { OPENROUTER_TEST_KEY: "test-key" },
        enabled: true,
        config: OpenRouterDriver.decodeConfig({
          url: `http://127.0.0.1:${address.port}/v1`,
          apiKeyEnv: "OPENROUTER_TEST_KEY",
        }),
      });
      const events: unknown[] = [];
      instance.adapter.onEvent((event) => events.push(event));
      const result = await instance.adapter.sendTurn({ threadId: "t-1", text: "hi" });
      assert.equal(result, "world");
      assert.ok(events.some((e) => (e as { type: string }).type === "text.delta"));
      await instance.dispose();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    }
  });
});
