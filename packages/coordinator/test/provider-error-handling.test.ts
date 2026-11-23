import * as http from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  UniversalLLMClient,
  ProviderError,
  classifyError,
  formatUserErrorMessage,
} from "../src/index.js";

describe("Provider error handling with real LLM client and HTTP stub server", () => {
  it("429 with Retry-After: drives real client, parses retryAfterMs, classifies nextAction with wait seconds", async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "2",
      });
      res.end(JSON.stringify({ error: { message: "Rate limit reached", code: "rate_limit_exceeded" } }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    const endpoint = `http://127.0.0.1:${port}/v1`;

    try {
      const client = new UniversalLLMClient({
        baseUrl: endpoint,
        model: "test-model",
        maxRetries: 0, // Fail immediately after first 429 to assert ProviderError properties
      });

      let thrownErr: any;
      try {
        await client.streamCompletion([{ role: "user", content: "test" }]);
      } catch (err) {
        thrownErr = err;
      }

      assert.ok(thrownErr, "Expected client to throw an error");
      assert.ok(thrownErr instanceof ProviderError, "Error must be instance of ProviderError");
      assert.strictEqual(thrownErr.status, 429);
      assert.strictEqual(thrownErr.statusCode, 429);
      assert.strictEqual(thrownErr.isProviderError, true);
      assert.strictEqual(thrownErr.retryAfterMs, 2000);
      assert.strictEqual(thrownErr.endpoint, `${endpoint}/chat/completions`);
      assert.strictEqual(thrownErr.upstreamDetail, "Rate limit reached");

      const classified = classifyError(thrownErr);
      assert.strictEqual(classified.code, "RATE_LIMIT_EXCEEDED");
      assert.strictEqual(classified.statusCode, 429);
      assert.strictEqual(classified.isUserFixable, true);
      assert.strictEqual(classified.cause, "You exceeded the model provider rate limit or token quota.");
      assert.strictEqual(classified.nextAction, "Wait 2s before retrying, or switch to another model in Settings.");
      assert.ok(!classified.nextAction.includes("--"), "Must not contain CLI flags");

      const userText = formatUserErrorMessage(classified);
      assert.strictEqual(userText, "You exceeded the model provider rate limit or token quota. Wait 2s before retrying, or switch to another model in Settings.");
      assert.ok(!userText.includes("at http"), "User text must not include raw URLs");
    } finally {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("429 without Retry-After: drives real client, classifies with general wait guidance", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Quota exceeded" } }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    const endpoint = `http://127.0.0.1:${port}/v1`;

    try {
      const client = new UniversalLLMClient({
        baseUrl: endpoint,
        model: "test-model",
        maxRetries: 0,
      });

      let thrownErr: any;
      try {
        await client.streamCompletion([{ role: "user", content: "test" }]);
      } catch (err) {
        thrownErr = err;
      }

      assert.ok(thrownErr instanceof ProviderError);
      assert.strictEqual(thrownErr.status, 429);
      assert.strictEqual(thrownErr.retryAfterMs, undefined);
      assert.strictEqual(thrownErr.upstreamDetail, "Quota exceeded");

      const classified = classifyError(thrownErr);
      assert.strictEqual(classified.code, "RATE_LIMIT_EXCEEDED");
      assert.strictEqual(classified.cause, "You exceeded the model provider rate limit or token quota.");
      assert.strictEqual(classified.nextAction, "Wait a few moments before trying again, or switch to another model in Settings.");
      assert.ok(!classified.nextAction.includes("--"), "Must not contain CLI flags");

      const userText = formatUserErrorMessage(classified);
      assert.strictEqual(userText, "You exceeded the model provider rate limit or token quota. Wait a few moments before trying again, or switch to another model in Settings.");
    } finally {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("402 Payment Required: drives real client without retry, classifies as insufficient credits", async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Credit balance too low", code: 402 } }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    const endpoint = `http://127.0.0.1:${port}/v1`;

    try {
      const client = new UniversalLLMClient({
        baseUrl: endpoint,
        model: "test-model",
        maxRetries: 3, // Should NOT retry 402
      });

      let thrownErr: any;
      try {
        await client.streamCompletion([{ role: "user", content: "test" }]);
      } catch (err) {
        thrownErr = err;
      }

      assert.strictEqual(requests, 1, "402 must not trigger retries");
      assert.ok(thrownErr instanceof ProviderError);
      assert.strictEqual(thrownErr.status, 402);
      assert.strictEqual(thrownErr.code, "402");
      assert.strictEqual(thrownErr.upstreamDetail, "Credit balance too low");

      const classified = classifyError(thrownErr);
      assert.strictEqual(classified.code, "INSUFFICIENT_CREDITS");
      assert.strictEqual(classified.statusCode, 402);
      assert.strictEqual(classified.isUserFixable, true);
      assert.strictEqual(classified.cause, "Your model provider account ran out of credits or requires payment.");
      assert.strictEqual(classified.nextAction, "Add credits in your provider dashboard, or switch to another model in Settings.");
      assert.ok(!classified.nextAction.includes("--"), "Must not contain CLI flags");

      const userText = formatUserErrorMessage(classified);
      assert.strictEqual(userText, "Your model provider account ran out of credits or requires payment. Add credits in your provider dashboard, or switch to another model in Settings.");
    } finally {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("503 Service Unavailable: bounded retries, classifies as provider overloaded", async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Model backend overloaded" } }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    const endpoint = `http://127.0.0.1:${port}/v1`;

    try {
      const client = new UniversalLLMClient({
        baseUrl: endpoint,
        model: "test-model",
        maxRetries: 2,
        initialBackoffMs: 5,
      });

      let thrownErr: any;
      try {
        await client.streamCompletion([{ role: "user", content: "test" }]);
      } catch (err) {
        thrownErr = err;
      }

      assert.strictEqual(requests, 3, "1 initial + 2 retries");
      assert.ok(thrownErr instanceof ProviderError);
      assert.strictEqual(thrownErr.status, 503);
      assert.strictEqual(thrownErr.upstreamDetail, "Model backend overloaded");

      const classified = classifyError(thrownErr);
      assert.strictEqual(classified.code, "PROVIDER_UNAVAILABLE");
      assert.strictEqual(classified.statusCode, 503);
      assert.strictEqual(classified.isUserFixable, false);
      assert.strictEqual(classified.cause, "The model provider is temporarily overloaded or down for maintenance.");
      assert.strictEqual(classified.nextAction, "Try again in a few minutes, or switch to another model in Settings.");
      assert.ok(!classified.nextAction.includes("--"), "Must not contain CLI flags");

      const userText = formatUserErrorMessage(classified);
      assert.strictEqual(userText, "The model provider is temporarily overloaded or down for maintenance. Try again in a few minutes, or switch to another model in Settings.");
    } finally {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("OpenRouter body 429: detects upstream rate-limited or daily quota error with desktop nextAction", async () => {
    let requests = 0;
    const openRouterPayload = {
      error: {
        message: "Provider returned error",
        code: 429,
        metadata: {
          raw: "upstream provider error: rate limit exceeded",
        },
      },
    };

    const server = http.createServer((_req, res) => {
      requests++;
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify(openRouterPayload));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    const endpoint = `http://127.0.0.1:${port}/v1`;

    try {
      const client = new UniversalLLMClient({
        baseUrl: endpoint,
        model: "openrouter/auto",
        provider: "openrouter",
        maxRetries: 0,
      });

      let thrownErr: any;
      try {
        await client.streamCompletion([{ role: "user", content: "test" }]);
      } catch (err) {
        thrownErr = err;
      }

      assert.ok(thrownErr instanceof ProviderError);
      assert.strictEqual(thrownErr.status, 429);
      assert.strictEqual(thrownErr.code, "429");
      assert.strictEqual(thrownErr.upstreamDetail, "Provider returned error");
      assert.strictEqual(thrownErr.provider, "openrouter");

      const classified = classifyError(thrownErr);
      assert.strictEqual(classified.code, "RATE_LIMIT_EXCEEDED");
      assert.strictEqual(classified.statusCode, 429);
      assert.strictEqual(classified.cause, "The upstream model provider is rate-limited or the model's daily limit was reached.");
      assert.strictEqual(classified.nextAction, "Wait a few moments before retrying, or switch to another model in Settings.");
      assert.ok(!classified.nextAction.includes("--"), "Must not contain CLI flags");

      const userText = formatUserErrorMessage(classified);
      assert.strictEqual(
        userText,
        "The upstream model provider is rate-limited or the model's daily limit was reached. Wait a few moments before retrying, or switch to another model in Settings."
      );

      // Verify exact Before vs After comparison
      const beforeText = `Error: Rate limit or quota exceeded (429 Too Many Requests) at ${endpoint}/chat/completions. Detail: Provider returned error`;
      const afterText = userText;
      assert.notStrictEqual(beforeText, afterText);
      assert.ok(!afterText.includes("http"), "After text must not leak endpoints or URLs");
      assert.ok(!afterText.includes("429 Too Many Requests"), "After text must be plain human words");
      assert.ok(afterText.includes("Settings"), "After text must guide user to desktop Settings");
    } finally {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("401 and 403: nextAction guides user to Settings without CLI flags", () => {
    const err401 = new ProviderError("Authentication failed", {
      status: 401,
      endpoint: "https://api.openai.com/v1/chat/completions",
      upstreamDetail: "Invalid API key",
    });
    const class401 = classifyError(err401);
    assert.strictEqual(class401.code, "AUTH_INVALID_KEY");
    assert.strictEqual(class401.nextAction, "Check or re-enter your API key in Settings.");
    assert.ok(!class401.nextAction.includes("--api-key"));

    const err403 = new ProviderError("Access forbidden", {
      status: 403,
      endpoint: "https://api.openai.com/v1/chat/completions",
      upstreamDetail: "Model access denied",
    });
    const class403 = classifyError(err403);
    assert.strictEqual(class403.code, "AUTH_FORBIDDEN");
    assert.strictEqual(class403.nextAction, "Check your API key permissions and model access in Settings.");
    assert.ok(!class403.nextAction.includes("--"));
  });
});
