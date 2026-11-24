import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UniversalLLMClient, ProviderError } from "../src/llm-client.js";

// Independent expectation: the production schedule is deliberately not imported.
const EXPECTED_BACKOFF_MS = [2000, 5000, 10000, 20000, 30000, 30000];
import { classifyError } from "../src/errors.js";
import { ChatMessage } from "../src/types.js";

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];

function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function rateLimited(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { message: "Provider returned error" } }), {
    status: 429,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("429 rate-limit retry policy (stub fetch, injected wait — no real network or sleep)", () => {
  it("429 then 200: retries once, onRetry fires with the wait, and the turn succeeds", async () => {
    let calls = 0;
    const mockFetch = async (): Promise<Response> => {
      calls++;
      return calls === 1 ? rateLimited({ "Retry-After": "7" }) : sseResponse("ok after wait");
    };
    const waits: number[] = [];
    const retries: any[] = [];
    const started = Date.now();
    const client = new UniversalLLMClient({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "free-model",
      provider: "openrouter",
      fetch: mockFetch as any,
      sleepFn: async (ms) => { waits.push(ms); },
      onRetry: (info) => { retries.push(info); },
    });

    const { stream, getConsolidated } = await client.streamCompletion(MESSAGES);
    for await (const _chunk of stream) { /* consume */ }

    assert.equal(calls, 2);
    assert.equal(getConsolidated().content, "ok after wait");
    assert.deepEqual(waits, [7000], "Retry-After: 7 must drive a ~7s wait");
    assert.equal(retries.length, 1);
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].maxRetries, EXPECTED_BACKOFF_MS.length);
    assert.equal(retries[0].status, 429);
    assert.equal(retries[0].provider, "openrouter");
    assert.ok(retries[0].retryAt >= started + 6900, "retryAt must carry a live countdown target");
  });

  it("repeats 429s with a patient, bounded schedule then succeeds", async () => {
    let calls = 0;
    const mockFetch = async (): Promise<Response> => {
      calls++;
      return calls <= EXPECTED_BACKOFF_MS.length ? rateLimited() : sseResponse("finally");
    };
    const waits: number[] = [];
    const client = new UniversalLLMClient({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "free-model",
      fetch: mockFetch as any,
      sleepFn: async (ms) => { waits.push(ms); },
    });

    const { stream, getConsolidated } = await client.streamCompletion(MESSAGES);
    for await (const _chunk of stream) { /* consume */ }

    assert.deepEqual(waits, [...EXPECTED_BACKOFF_MS]);
    assert.equal(calls, EXPECTED_BACKOFF_MS.length + 1, "bounded: initial request + six retries");
    assert.equal(getConsolidated().content, "finally");
  });

  it("X-RateLimit-Reset hours away: no wait, one request, plain error naming the reset time", async () => {
    const resetAt = Date.now() + 3 * 60 * 60 * 1000;
    let calls = 0;
    let waits = 0;
    let retries = 0;
    const mockFetch = async (): Promise<Response> => {
      calls++;
      return rateLimited({ "X-RateLimit-Reset": String(resetAt) });
    };
    const client = new UniversalLLMClient({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "free-model",
      provider: "openrouter",
      fetch: mockFetch as any,
      sleepFn: async () => { waits++; },
      onRetry: () => { retries++; },
    });

    let thrown: any;
    try {
      await client.streamCompletion(MESSAGES);
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof ProviderError);
    assert.equal(thrown.status, 429);
    assert.equal(thrown.resetAt, resetAt);
    assert.equal(calls, 1, "a daily quota must not burn requests");
    assert.equal(waits, 0, "a daily quota must not wait");
    assert.equal(retries, 0, "a daily quota must not announce a retry");

    const classified = classifyError(thrown);
    assert.equal(classified.code, "RATE_LIMIT_EXCEEDED");
    assert.ok(classified.cause.includes(new Date(resetAt).toLocaleTimeString()), "reset time is named");
    assert.ok(classified.nextAction.includes("another model in Settings"), "must suggest switching model");
    const userText = `${classified.cause} ${classified.nextAction}`;
    assert.ok(!userText.includes("--"), "no CLI flags in desktop text");
    assert.ok(!userText.includes("http"), "no raw endpoint in desktop text");
  });

  it("X-RateLimit-Reset a few seconds away: waits until the reset instead of the default backoff", async () => {
    const resetAt = Date.now() + 4000;
    let calls = 0;
    const mockFetch = async (): Promise<Response> => {
      calls++;
      return calls === 1 ? rateLimited({ "X-RateLimit-Reset": String(resetAt) }) : sseResponse("after reset");
    };
    const waits: number[] = [];
    const client = new UniversalLLMClient({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "free-model",
      fetch: mockFetch as any,
      sleepFn: async (ms) => { waits.push(ms); },
    });

    const { stream, getConsolidated } = await client.streamCompletion(MESSAGES);
    for await (const _chunk of stream) { /* consume */ }

    assert.equal(calls, 2);
    assert.ok(waits[0] >= 3900 && waits[0] <= 4000, `should wait until reset, got ${waits[0]}ms`);
    assert.equal(getConsolidated().content, "after reset");
  });

  it("abort during a rate-limit wait stops within 100ms and issues no further request", async () => {
    let calls = 0;
    let markRequested!: () => void;
    const requested = new Promise<void>((resolve) => { markRequested = resolve; });
    const mockFetch = async (): Promise<Response> => {
      calls++;
      markRequested();
      return rateLimited({ "Retry-After": "20" });
    };
    const client = new UniversalLLMClient({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "free-model",
      fetch: mockFetch as any,
      sleepFn: (ms, signal) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const err: any = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        }, { once: true });
      }),
    });
    const controller = new AbortController();
    const pending = client.streamCompletion(MESSAGES, undefined, controller.signal);

    await requested;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const abortStart = Date.now();
    controller.abort();

    await assert.rejects(pending, (err: any) => err.name === "AbortError");
    assert.ok(Date.now() - abortStart < 100, "stop must cancel the wait immediately");
    assert.equal(calls, 1, "no request after the abort");
  });

  it("maxRetries: 0 still disables retries for 429", async () => {
    let calls = 0;
    const mockFetch = async (): Promise<Response> => { calls++; return rateLimited(); };
    const client = new UniversalLLMClient({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "free-model",
      maxRetries: 0,
      fetch: mockFetch as any,
      sleepFn: async () => { throw new Error("must not sleep"); },
    });
    await assert.rejects(() => client.streamCompletion(MESSAGES), (err: any) => err instanceof ProviderError);
    assert.equal(calls, 1);
  });
});
