import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createServer } from "node:http";
import { KimiAgentDriver } from "../src/providers/kimi-agent-driver.js";
import { GrokApiDriver } from "../src/providers/grok-api-driver.js";
import { FAKE_ACP, readJsonl, writeFakeCli } from "./helpers/fake-cli.js";

describe("factory-driven ACP driver (Kimi)", () => {
  let tmpDir: string;
  let cli: string;
  let argvLog: string;
  let msgLog: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-kimi-test-"));
    cli = await writeFakeCli(tmpDir, "fake-kimi", FAKE_ACP);
    argvLog = path.join(tmpDir, "argv.jsonl");
    msgLog = path.join(tmpDir, "msg.jsonl");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("performs the ACP handshake and completes a turn", { timeout: 15_000 }, async () => {
    const instance = await KimiAgentDriver.create({
      instanceId: "kimi-proto",
      displayName: "Kimi",
      environment: { ARGV_LOG: argvLog, MSG_LOG: msgLog },
      enabled: true,
      config: KimiAgentDriver.decodeConfig({ cli }),
    });
    const result = await instance.adapter.sendTurn({ threadId: "t", text: "hi", model: "kimi-code/k3" });
    assert.equal((result as { text: string }).text, "hello");

    const argv = await readJsonl(argvLog) as string[][];
    assert.deepEqual(argv[0], ["acp"]);
    const messages = await readJsonl(msgLog) as Array<{ method: string }>;
    assert.equal(messages[0].method, "initialize");
    assert.ok(messages.some((m) => m.method === "session/prompt"));
    await instance.dispose();
  });
});

describe("factory-driven API driver (Grok)", () => {
  it("streams a turn using its configured key and endpoint", async () => {
    const server = createServer((req, res) => {
      assert.equal(req.headers["authorization"], "Bearer factory-test-key");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"grok"},"finish_reason":null}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      const instance = await GrokApiDriver.create({
        instanceId: "grok-factory",
        displayName: "Grok",
        environment: { XAI_API_KEY: "factory-test-key" },
        enabled: true,
        config: GrokApiDriver.decodeConfig({ url: `http://127.0.0.1:${address.port}/v1` }),
      });
      const generate = instance.generateText;
      assert.ok(generate);
      assert.equal(await generate("hi"), "grok");
      await instance.dispose();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    }
  });
});
