import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { UniversalLLMClient } from "../src/llm-client.js";
import { ChatMessage } from "../src/types.js";

describe("UniversalLLMClient", () => {
  let server: http.Server;
  let serverUrl: string;
  let lastRequestBody: any = null;

  before(async () => {
    server = http.createServer((req, res) => {
      let bodyStr = "";
      req.on("data", (chunk) => {
        bodyStr += chunk;
      });

      req.on("end", () => {
        try {
          lastRequestBody = JSON.parse(bodyStr);
        } catch {
          lastRequestBody = null;
        }

        if (req.url?.includes("/v1/chat/completions")) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          // Send mock streaming chunks
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "Hello " } }],
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "world!" } }],
            })}\n\n`
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(404);
          res.end("Not Found");
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("streams chat completions from OpenAI-compatible endpoint", async () => {
    const client = new UniversalLLMClient({
      baseUrl: serverUrl,
      model: "gpt-4o",
      apiKey: "sk-test",
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
    assert.equal(lastRequestBody.model, "gpt-4o");
    assert.equal(lastRequestBody.stream, true);
  });
});
