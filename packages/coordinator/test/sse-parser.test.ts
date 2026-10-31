import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSSEStream } from "../src/sse-parser.js";

describe("SSEParser", () => {
  it("parses single and multi-chunk SSE streams", async () => {
    async function* generateChunks(): AsyncIterable<Uint8Array> {
      const encoder = new TextEncoder();
      yield encoder.encode("data: {\"token\": 1}\n\n");
      yield encoder.encode("data: {\"token\": 2}\r\n\r\n");
      yield encoder.encode(": keepalive ping\n");
      yield encoder.encode("data: [DONE]\n\n");
    }

    const payloads: string[] = [];
    for await (const payload of parseSSEStream(generateChunks())) {
      payloads.push(payload);
    }

    assert.deepEqual(payloads, ['{"token": 1}', '{"token": 2}', "[DONE]"]);
  });

  it("handles fragmented chunk boundaries seamlessly", async () => {
    async function* generateFragmented(): AsyncIterable<Uint8Array> {
      const encoder = new TextEncoder();
      yield encoder.encode("da");
      yield encoder.encode("ta: {\"msg\": \"hel");
      yield encoder.encode("lo\"}\n\n");
      yield encoder.encode("data: [DO");
      yield encoder.encode("NE]\n\n");
    }

    const payloads: string[] = [];
    for await (const payload of parseSSEStream(generateFragmented())) {
      payloads.push(payload);
    }

    assert.deepEqual(payloads, ['{"msg": "hello"}', "[DONE]"]);
  });
});
