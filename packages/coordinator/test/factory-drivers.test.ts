import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createServer } from "node:http";
import type { ProviderInstance } from "@opensand/shared";
import { KimiAgentDriver } from "../src/providers/kimi-agent-driver.js";
import { GrokAgentDriver } from "../src/providers/grok-agent-driver.js";
import { GrokApiDriver } from "../src/providers/grok-api-driver.js";
import { credentialHome, type DeviceAuthSpec } from "../src/providers/runtime/device-auth.js";
import { FAKE_ACP, readJsonl, writeFakeCli } from "./helpers/fake-cli.js";

const GROK_AUTH_SPEC: DeviceAuthSpec = {
  provider: "grok",
  homeEnv: "GROK_HOME",
  homeDir: ".grok",
  loginArgs: ["login", "--device-auth"],
  signedInFile: "auth.json",
  urlPattern: /https:\/\/(?:x\.ai|grok\.com)\/\S+/i,
  codePattern: /\b[A-Z0-9]{4,12}\b/,
  failureMessage: "Grok device sign-in failed. Check the CLI output in Settings.",
};

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

  it("passes the stable credential home into ACP sessions", { timeout: 15_000 }, async () => {
    const homeMarker = path.join(tmpDir, "grok-home.txt");
    const homeCli = await writeFakeCli(tmpDir, "fake-grok-home", FAKE_ACP.replace(
      'const fs = require("fs");',
      'const fs = require("fs");\nfs.writeFileSync(process.env.HOME_MARKER, String(process.env.GROK_HOME));'
    ));
    const savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    let instance: ProviderInstance | undefined;
    try {
      instance = await GrokAgentDriver.create({
        instanceId: "grok-home-probe",
        displayName: "Grok",
        environment: { HOME_MARKER: homeMarker },
        enabled: true,
        config: GrokAgentDriver.decodeConfig({ cli: homeCli }),
      });
      const result = await instance.adapter.sendTurn({ threadId: "grok-home", text: "hi" });
      assert.equal((result as { text: string }).text, "hello");
      assert.equal(await fs.readFile(homeMarker, "utf8"), credentialHome(GROK_AUTH_SPEC));
    } finally {
      await instance?.dispose();
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
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
