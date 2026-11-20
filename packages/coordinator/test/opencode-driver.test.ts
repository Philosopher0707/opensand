import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { OpenCodeDriver } from "../src/providers/opencode-driver.js";
import { FAKE_ACP, readJsonl, writeFakeCli } from "./helpers/fake-cli.js";

describe("OpenCodeDriver", () => {
  let tmpDir: string;
  let cli: string;
  let argvLog: string;
  let msgLog: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-opencode-test-"));
    cli = await writeFakeCli(tmpDir, "fake-opencode", FAKE_ACP);
    argvLog = path.join(tmpDir, "argv.jsonl");
    msgLog = path.join(tmpDir, "msg.jsonl");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("decodes config and exposes metadata", () => {
    assert.deepEqual(OpenCodeDriver.decodeConfig({}), { cli: "opencode", fullAuto: false });
    assert.equal(OpenCodeDriver.driverKind, "opencode");
    assert.equal(OpenCodeDriver.metadata.displayName, "OpenCode");
    assert.equal(OpenCodeDriver.models.default, "opencode/auto");
  });

  it("creates an instance with expected shape", async () => {
    const instance = await OpenCodeDriver.create({
      instanceId: "opencode-1",
      displayName: "OpenCode Test",
      environment: {},
      enabled: true,
      config: OpenCodeDriver.decodeConfig({ cli }),
    });
    const snap = await instance.snapshot();
    assert.equal(snap.instanceId, "opencode-1");
    assert.equal(snap.driverKind, "opencode");
    assert.equal(snap.enabled, true);
    assert.equal(instance.adapter.provider, "opencode");
    await instance.dispose();
  });

  it("spawns `opencode acp`, performs the ACP handshake and streams a turn", { timeout: 15_000 }, async () => {
    const instance = await OpenCodeDriver.create({
      instanceId: "opencode-proto",
      displayName: "Protocol Test",
      environment: { ARGV_LOG: argvLog, MSG_LOG: msgLog },
      enabled: true,
      config: OpenCodeDriver.decodeConfig({ cli, fullAuto: true }),
    });

    const events: Array<{ type: string }> = [];
    instance.adapter.onEvent((event) => events.push(event as { type: string }));

    const result = await instance.adapter.sendTurn({
      threadId: "thread-1",
      text: "hello",
      model: "opencode/auto",
    });
    assert.equal((result as { text: string }).text, "hello");
    assert.ok(events.some((e) => e.type === "text.delta"));
    assert.equal(instance.adapter.hasSession("thread-1"), true);

    const argv = await readJsonl(argvLog) as string[][];
    assert.deepEqual(argv[0], ["acp"]);

    const messages = await readJsonl(msgLog) as Array<{ id?: number; method: string; params?: Record<string, unknown> }>;
    const methods = messages.map((m) => m.method);
    assert.equal(methods[0], "initialize");
    assert.ok(methods.includes("session/new"));
    assert.ok(methods.includes("session/set_config_option"));
    assert.ok(methods.includes("session/prompt"));
    const prompt = messages.find((m) => m.method === "session/prompt");
    assert.deepEqual(prompt?.params?.prompt, [{ type: "text", text: "hello" }]);

    await instance.adapter.stopAll();
    await instance.dispose();
  });
});
