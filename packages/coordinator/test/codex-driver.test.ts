import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { CodexDriver } from "../src/providers/codex-driver.js";
import { FAKE_CODEX, readJsonl, writeFakeCli } from "./helpers/fake-cli.js";

describe("CodexDriver", () => {
  let tmpDir: string;
  let cli: string;
  let argvLog: string;
  let msgLog: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-codex-test-"));
    cli = await writeFakeCli(tmpDir, "fake-codex", FAKE_CODEX);
    argvLog = path.join(tmpDir, "argv.jsonl");
    msgLog = path.join(tmpDir, "msg.jsonl");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("decodes config with defaults, custom values and validation", () => {
    assert.deepEqual(CodexDriver.decodeConfig({}), { cli: "codex", fullAuto: false });
    assert.deepEqual(CodexDriver.decodeConfig({ cli: "/bin/codex", fullAuto: true, authMode: "chatgpt-plan" }), {
      cli: "/bin/codex",
      fullAuto: true,
      authMode: "chatgpt-plan",
    });
    assert.throws(() => CodexDriver.decodeConfig({ fullAuto: 1 }), /fullAuto must be a boolean/);
  });

  it("exposes catalog and metadata", () => {
    assert.equal(CodexDriver.driverKind, "codex");
    assert.equal(CodexDriver.metadata.displayName, "Codex");
    assert.equal(CodexDriver.metadata.access, "custom");
    assert.equal(CodexDriver.models.default, "codex-mini-latest");
  });

  it("creates an instance with expected shape", async () => {
    const instance = await CodexDriver.create({
      instanceId: "codex-1",
      displayName: "Codex Test",
      environment: {},
      enabled: true,
      config: CodexDriver.decodeConfig({ cli }),
    });
    assert.equal(instance.instanceId, "codex-1");
    assert.equal((await instance.snapshot()).driverKind, "codex");
    assert.equal(instance.adapter.provider, "codex");
    assert.equal(instance.adapter.capabilities.sessionModelSwitch, "between-turns");
    await instance.dispose();
  });

  it("spawns app-server, performs the JSON-RPC handshake, streams text and completes on turn/completed", { timeout: 15_000 }, async () => {
    const instance = await CodexDriver.create({
      instanceId: "codex-proto",
      displayName: "Protocol Test",
      environment: { ARGV_LOG: argvLog, MSG_LOG: msgLog },
      enabled: true,
      config: CodexDriver.decodeConfig({ cli, fullAuto: true }),
    });

    const events: Array<{ type: string }> = [];
    instance.adapter.onEvent((event) => events.push(event as { type: string }));

    const result = await instance.adapter.sendTurn({ threadId: "thread-1", text: "hello" });
    assert.equal((result as { text: string }).text, "hello");
    assert.ok(events.some((e) => e.type === "text.delta"));
    assert.equal(instance.adapter.hasSession("thread-1"), true);

    const argv = await readJsonl(argvLog) as string[][];
    assert.equal(argv.length, 1);
    assert.deepEqual(argv[0], ["app-server"], "Codex must use the app-server subcommand, not Claude stream-json flags");

    const messages = await readJsonl(msgLog) as Array<{ id?: number; method: string; params?: Record<string, unknown> }>;
    const methods = messages.map((m) => m.method);
    assert.equal(methods[0], "initialize");
    assert.ok(messages.some((m) => m.method === "initialized"), "initialized notification must be sent");
    assert.ok(messages.some((m) => m.method === "thread/start"));
    assert.ok(messages.some((m) => m.method === "turn/start"));
    const turnStart = messages.find((m) => m.method === "turn/start");
    assert.ok(Array.isArray(turnStart?.params?.input));

    await instance.adapter.stopAll();
    await instance.dispose();
  });
});
