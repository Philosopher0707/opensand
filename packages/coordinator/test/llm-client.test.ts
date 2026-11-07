import * as http from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UniversalLLMClient, NetworkError } from "../src/llm-client.js";
import { ChatMessage } from "../src/types.js";

describe("UniversalLLMClient", () => {
  it("streams chat completions from OpenAI-compatible endpoint", async () => {
    let capturedBody: any = null;

    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      capturedBody = JSON.parse(init.body as string);
      const encoder = new TextEncoder();

      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "world!" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ];

      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) {
            controller.enqueue(encoder.encode(c));
          }
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKey: "sk-test",
      fetch: mockFetch as any,
    });

    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const { stream, getConsolidated } = await client.streamCompletion(messages);

    const deltas: string[] = [];
    for await (const chunk of stream) {
      if (chunk.content) deltas.push(chunk.content);
    }

    assert.deepEqual(deltas, ["Hello ", "world!"]);
    const consolidated = getConsolidated();
    assert.equal(consolidated.role, "assistant");
    assert.equal(consolidated.content, "Hello world!");
    assert.equal(capturedBody.model, "gpt-4o");
    assert.equal(capturedBody.stream, true);
  });

  it("handles 401 unauthorized with actionable diagnostics", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: { message: "You didn't provide an API key." } }), {
        status: 401,
        statusText: "Unauthorized",
      });
    };

    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: mockFetch as any,
    });

    await assert.rejects(
      async () => {
        await client.streamCompletion([{ role: "user", content: "hey" }]);
      },
      (err: Error) => {
        assert.ok(err.message.includes("401 Unauthorized"));
        assert.ok(err.message.includes("Provide an API key"));
        return true;
      }
    );
  });

  it("handles ECONNREFUSED with local model instructions", async () => {
    const mockFetch = async (): Promise<Response> => {
      const err: any = new Error("connect ECONNREFUSED 127.0.0.1:11434");
      err.code = "ECONNREFUSED";
      throw err;
    };

    const client = new UniversalLLMClient({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      fetch: mockFetch as any,
    });

    await assert.rejects(
      async () => {
        await client.streamCompletion([{ role: "user", content: "test" }]);
      },
      (err: Error) => {
        assert.ok(err.message.includes("Connection refused"));
        assert.ok(err.message.includes("ollama serve"));
        return true;
      }
    );
  });

  it("handles 404 Not Found with model lookup hint", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: { message: "Model not found" } }), {
        status: 404,
        statusText: "Not Found",
      });
    };

    const client = new UniversalLLMClient({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "unknown-model",
      fetch: mockFetch as any,
    });

    await assert.rejects(
      async () => {
        await client.streamCompletion([{ role: "user", content: "test" }]);
      },
      (err: Error) => {
        assert.ok(err.message.includes("404 Not Found"));
        assert.ok(err.message.includes("Check available models"));
        return true;
      }
    );
  });

  it("aborts stream early when AbortSignal triggers", async () => {
    const encoder = new TextEncoder();
    const abortController = new AbortController();

    const mockFetch = async (): Promise<Response> => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "part1" } }] })}\n\n`)
          );
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "part2" } }] })}\n\n`)
          );
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const client = new UniversalLLMClient({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      fetch: mockFetch as any,
    });

    const { stream } = await client.streamCompletion(
      [{ role: "user", content: "test" }],
      undefined,
      abortController.signal
    );

    const chunks: string[] = [];
    for await (const chunk of stream) {
      if (chunk.content) {
        chunks.push(chunk.content);
        abortController.abort();
      }
    }

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "part1");
  });

  it("handles offline DNS failure (ENOTFOUND / EAI_AGAIN) with NetworkError", async () => {
    const mockFetch = async (): Promise<Response> => {
      const err: any = new TypeError("fetch failed");
      err.cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.openai.com"), { code: "ENOTFOUND" });
      throw err;
    };

    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: mockFetch as any,
    });

    await assert.rejects(
      async () => {
        await client.streamCompletion([{ role: "user", content: "test" }]);
      },
      (err: any) => {
        assert.ok(err instanceof NetworkError);
        assert.equal(err.code, "ENOTFOUND");
        assert.equal(err.endpoint, "https://api.openai.com/v1/chat/completions");
        assert.ok(err.message.includes("DNS lookup failed"));
        assert.ok(err.message.includes("api.openai.com"));
        return true;
      }
    );
  });

  it("handles server-down mid-stream (ECONNRESET) with NetworkError", async () => {
    const encoder = new TextEncoder();
    const mockFetch = async (): Promise<Response> => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "part1" } }] })}\n\n`)
          );
          // Simulate socket reset mid-stream
          const resetErr: any = new Error("read ECONNRESET");
          resetErr.code = "ECONNRESET";
          controller.error(resetErr);
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const client = new UniversalLLMClient({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      fetch: mockFetch as any,
    });

    const { stream } = await client.streamCompletion([{ role: "user", content: "test" }]);

    await assert.rejects(
      async () => {
        for await (const chunk of stream) {
          // iterate until mid-stream error
        }
      },
      (err: any) => {
        assert.ok(err instanceof NetworkError);
        assert.equal(err.code, "ECONNRESET");
        assert.ok(err.message.includes("reset"));
        return true;
      }
    );
  });

  it("handles request timeout with NetworkError", async () => {
    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      return new Promise((_, reject) => {
        if (init.signal) {
          init.signal.addEventListener("abort", () => {
            const err: any = new Error("The operation was aborted");
            err.name = "TimeoutError";
            reject(err);
          });
        }
      });
    };

    const client = new UniversalLLMClient({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      timeoutMs: 50,
      fetch: mockFetch as any,
    });

    await assert.rejects(
      async () => {
        await client.streamCompletion([{ role: "user", content: "test" }]);
      },
      (err: any) => {
        assert.ok(err instanceof NetworkError);
        assert.equal(err.code, "ETIMEDOUT");
        assert.ok(err.message.includes("timed out after 50ms"));
        return true;
      }
    );
  });

  it("handles network unreachable (ENETUNREACH) with NetworkError", async () => {
    const mockFetch = async (): Promise<Response> => {
      const err: any = new Error("connect ENETUNREACH 192.168.1.100");
      err.code = "ENETUNREACH";
      throw err;
    };

    const client = new UniversalLLMClient({
      baseUrl: "http://192.168.1.100:11434/v1",
      model: "qwen3:8b",
      fetch: mockFetch as any,
    });

    await assert.rejects(
      async () => {
        await client.streamCompletion([{ role: "user", content: "test" }]);
      },
      (err: any) => {
        assert.ok(err instanceof NetworkError);
        assert.equal(err.code, "ENETUNREACH");
        assert.ok(err.message.includes("Network unreachable"));
        return true;
      }
    );
  });

  it("429 + Retry-After then 200 succeeds and waited", async () => {
    let requestCount = 0;

    const server = http.createServer((req, res) => {
      requestCount++;
      if (requestCount === 1) {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": "1",
        });
        res.end(JSON.stringify({ error: { message: "Too many requests" } }));
      } else {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Success after 429" } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    const startTime = Date.now();

    try {
      const client = new UniversalLLMClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "gpt-4o",
      });

      const { stream, getConsolidated } = await client.streamCompletion([{ role: "user", content: "hi" }]);
      for await (const chunk of stream) {
        // consume
      }
      const consolidated = getConsolidated();
      assert.equal(consolidated.content, "Success after 429");
      assert.equal(requestCount, 2);
      assert.ok(Date.now() - startTime >= 900, "Should have waited for Retry-After duration");
    } finally {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("503 x 3 => classified error after bounded retries", async () => {
    let requestCount = 0;
    const server = http.createServer((_req, res) => {
      requestCount++;
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Provider unavailable" } }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;

    try {
      const client = new UniversalLLMClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "gpt-4o",
        maxRetries: 3,
        initialBackoffMs: 10,
      });

      await assert.rejects(
        async () => {
          await client.streamCompletion([{ role: "user", content: "test" }]);
        },
        (err: Error) => {
          assert.ok(err.message.includes("503"));
          assert.ok(err.message.includes("Provider unavailable"));
          return true;
        }
      );
      assert.equal(requestCount, 4); // 1 initial + 3 retries
    } finally {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("partial stream then close => no retry", async () => {
    let requestCount = 0;
    const server = http.createServer((_req, res) => {
      requestCount++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial token" } }] })}\n\n`);
      setTimeout(() => {
        res.destroy(new Error("socket destroyed mid-stream"));
      }, 20);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;

    try {
      const client = new UniversalLLMClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "gpt-4o",
        maxRetries: 3,
        initialBackoffMs: 10,
      });

      const { stream } = await client.streamCompletion([{ role: "user", content: "test" }]);
      const chunks: string[] = [];
      await assert.rejects(
        async () => {
          for await (const chunk of stream) {
            if (chunk.content) chunks.push(chunk.content);
          }
        },
        (err: any) => {
          assert.ok(err);
          return true;
        }
      );

      assert.equal(requestCount, 1); // No retry after partial stream!
      assert.deepEqual(chunks, ["partial token"]);
    } finally {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("abort during backoff => immediate rejection", async () => {
    let requestCount = 0;
    const server = http.createServer((_req, res) => {
      requestCount++;
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "20", // 20s backoff
      });
      res.end(JSON.stringify({ error: { message: "Rate limit" } }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;
    const abortController = new AbortController();

    try {
      const client = new UniversalLLMClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "gpt-4o",
      });

      const start = Date.now();
      setTimeout(() => abortController.abort(), 50);

      await assert.rejects(
        async () => {
          await client.streamCompletion(
            [{ role: "user", content: "test" }],
            undefined,
            abortController.signal
          );
        },
        (err: any) => {
          assert.equal(err.name, "AbortError");
          return true;
        }
      );

      assert.ok(Date.now() - start < 1000, "Should abort immediately without waiting 20s");
      assert.equal(requestCount, 1);
    } finally {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("stream stall watchdog aborts with classified timeout", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "first chunk" } }] })}\n\n`);
      // Intentionally do not send anything more
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;

    try {
      const client = new UniversalLLMClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "gpt-4o",
        streamIdleTimeoutMs: 100, // 100ms idle threshold
      });

      const { stream } = await client.streamCompletion([{ role: "user", content: "test" }]);
      const chunks: string[] = [];

      await assert.rejects(
        async () => {
          for await (const chunk of stream) {
            if (chunk.content) chunks.push(chunk.content);
          }
        },
        (err: any) => {
          assert.ok(err instanceof NetworkError);
          assert.equal(err.code, "ETIMEDOUT");
          assert.ok(err.message.includes("stream stalled"));
          return true;
        }
      );

      assert.deepEqual(chunks, ["first chunk"]);
    } finally {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

});
