import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDriverLlmClient, driverKindForProvider } from "../src/provider-llm.js";
import { providerRegistry } from "../src/provider-registry.js";
import type { ProviderDriver } from "@opensand/shared";

describe("provider-llm production bridge", () => {
  it("maps the app's provider names to driver kinds", () => {
    assert.equal(driverKindForProvider("openrouter"), "openrouter");
    assert.equal(driverKindForProvider("Anthropic"), "anthropic");
    assert.equal(driverKindForProvider("openai"), null);
  });

  it("builds an LLM client through the registered OpenRouter driver", async () => {
    const client = await createDriverLlmClient({
      provider: "openrouter",
      endpoint: "https://openrouter.ai/api/v1",
      model: "openrouter/auto",
      apiKey: "test-key",
    });
    assert.ok(client, "a registered API driver must produce a client");
    assert.equal(client.model, "openrouter/auto");
  });

  it("builds an LLM client through the registered Anthropic driver", async () => {
    const client = await createDriverLlmClient({
      provider: "anthropic",
      endpoint: "https://api.anthropic.com/v1",
      model: "claude-3-7-sonnet-20250219",
      apiKey: "test-key",
    });
    assert.ok(client);
    assert.equal(client.model, "claude-3-7-sonnet-20250219");
  });

  it("returns a client that actually uses the driver's HTTP configuration", async () => {
    const { createServer } = await import("node:http");
    let seenHeaders: Record<string, string | string[] | undefined> = {};
    const server = createServer((req, res) => {
      seenHeaders = req.headers;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    try {
      const client = await createDriverLlmClient({
        provider: "openrouter",
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        model: "openrouter/auto",
        apiKey: "driver-key",
      });
      assert.ok(client);
      const { stream } = await client.streamCompletion([{ role: "user", content: "hi" }]);
      for await (const _chunk of stream) { /* drain */ }
      assert.equal(seenHeaders["http-referer"], "https://opensand.dev");
      assert.equal(seenHeaders["x-title"], "OpenSand");
      assert.equal(seenHeaders["authorization"], "Bearer driver-key");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    }
  });

  it("returns null for local/unmapped providers so the legacy path is used", async () => {
    assert.equal(await createDriverLlmClient({
      provider: "openai",
      endpoint: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      apiKey: "none",
    }), null);
  });

  it("never leaves a registry instance behind for non-API drivers", async () => {
    const models = { default: "fake-1", options: [{ id: "fake-1", label: "Fake" }] };
    const fake: ProviderDriver = {
      driverKind: "fake-cli-driver",
      metadata: { displayName: "Fake", access: "custom" },
      models,
      decodeConfig: (raw) => raw,
      defaultConfig: () => ({}),
      async create(input) {
        return {
          instanceId: input.instanceId,
          driverKind: "fake-cli-driver",
          displayName: input.displayName,
          enabled: input.enabled,
          models,
          adapter: {
            provider: "fake-cli-driver",
            capabilities: {},
            async sendTurn() { return ""; },
            steer: () => Promise.resolve(),
            interruptTurn: () => Promise.resolve(),
            respondToRequest: () => Promise.resolve("unavailable" as const),
            hasSession: () => false,
            enginePid: () => undefined,
            stopAll: () => Promise.resolve(),
            onEvent: () => () => {},
          },
          snapshot: async () => ({
            instanceId: input.instanceId,
            driverKind: "fake-cli-driver",
            enabled: input.enabled,
          }),
          dispose: () => Promise.resolve(),
        };
      },
    };
    // createDriverLlmClient uses the singleton; node:test runs each file in its
    // own process, so registering here cannot affect other test files.
    providerRegistry.register(fake);
    assert.equal(providerRegistry.listInstances().length, 0);
    assert.equal(await createDriverLlmClient({
      provider: "fake-cli-driver",
      endpoint: "",
      model: "fake-1",
      apiKey: "",
    }), null);
    assert.equal(providerRegistry.listInstances().length, 0, "factory instances must be disposed");
  });
});
