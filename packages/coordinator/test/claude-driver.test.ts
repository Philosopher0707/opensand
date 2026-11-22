import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ClaudeDriver } from "../src/providers/claude-driver.js";
import { FAKE_CLAUDE, readJsonl, writeFakeCli } from "./helpers/fake-cli.js";

describe("ClaudeDriver", () => {
  let tmpDir: string;
  let cli: string;
  let argvLog: string;
  let msgLog: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-claude-test-"));
    cli = await writeFakeCli(tmpDir, "fake-claude", FAKE_CLAUDE);
    argvLog = path.join(tmpDir, "argv.jsonl");
    msgLog = path.join(tmpDir, "msg.jsonl");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("decodes config with defaults and custom values", () => {
    assert.deepEqual(ClaudeDriver.decodeConfig({}), { cli: "claude", fullAuto: false });
    assert.deepEqual(ClaudeDriver.decodeConfig({ cli: "/bin/claude", fullAuto: true, configDir: "/tmp/c" }), {
      cli: "/bin/claude",
      fullAuto: true,
      configDir: "/tmp/c",
    });
    assert.throws(() => ClaudeDriver.decodeConfig({ cli: 3 }), /cli must be a string/);
    assert.throws(() => ClaudeDriver.decodeConfig({ fullAuto: "yes" }), /fullAuto must be a boolean/);
  });

  it("exposes catalog and metadata", () => {
    assert.equal(ClaudeDriver.driverKind, "claude-code");
    assert.equal(ClaudeDriver.metadata.displayName, "Claude Code");
    assert.equal(ClaudeDriver.metadata.access, "custom");
    assert.equal(ClaudeDriver.models.default, "claude-3-7-sonnet-20250219");
  });

  it("creates an instance with expected shape", async () => {
    const instance = await ClaudeDriver.create({
      instanceId: "claude-1",
      displayName: "Claude Test",
      environment: {},
      enabled: true,
      config: ClaudeDriver.decodeConfig({ cli }),
    });
    assert.equal(instance.instanceId, "claude-1");
    assert.equal(instance.driverKind, "claude-code");
    assert.equal((await instance.snapshot()).enabled, true);
    assert.equal(instance.adapter.provider, "claude-code");
    assert.equal(instance.adapter.hasSession("t"), false);
    await instance.dispose();
  });

  it("spawns the correct stream-json CLI, streams text and retains one process across turns", { timeout: 15_000 }, async () => {
    const instance = await ClaudeDriver.create({
      instanceId: "claude-proto",
      displayName: "Protocol Test",
      environment: { ARGV_LOG: argvLog, MSG_LOG: msgLog },
      enabled: true,
      config: ClaudeDriver.decodeConfig({ cli, fullAuto: true }),
    });

    const events: Array<{ type: string }> = [];
    instance.adapter.onEvent((event) => events.push(event as { type: string }));

    const first = await instance.adapter.sendTurn({ threadId: "thread-1", text: "first" });
    const pid = instance.adapter.enginePid("thread-1");
    const second = await instance.adapter.sendTurn({ threadId: "thread-1", text: "second" });

    assert.equal((first as { text: string }).text, "hello");
    assert.equal((second as { text: string }).text, "hello");
    assert.equal(instance.adapter.enginePid("thread-1"), pid, "process must be retained across turns");
    assert.equal(instance.adapter.hasSession("thread-1"), true);
    assert.ok(events.some((e) => e.type === "text.delta"));
    assert.ok(events.some((e) => e.type === "assistant_text"));

    const argv = await readJsonl(argvLog) as string[][];
    assert.equal(argv.length, 1, "fake CLI should be spawned exactly once");
    const args = argv[0];
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("--output-format") && args.includes("stream-json"));
    assert.ok(args.includes("--input-format") && args.includes("stream-json"));
    assert.ok(args.includes("--verbose"));
    assert.ok(args.includes("--include-partial-messages"));
    assert.ok(args.includes("--permission-mode") && args.includes("bypassPermissions"));

    const messages = await readJsonl(msgLog) as Array<{ message: { content: string } }>;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].message.content, "first");
    assert.equal(messages[1].message.content, "second");

    await instance.adapter.stopAll();
    await instance.dispose();
  });

  it("passes the framework prompt once via --system-prompt and never repeats it in user turns", { timeout: 15_000 }, async () => {
    const systemText = "You are OpenSand, a test framework prompt.";
    const sysArgvLog = path.join(tmpDir, "sys-argv.jsonl");
    const sysMsgLog = path.join(tmpDir, "sys-msg.jsonl");
    const instance = await ClaudeDriver.create({
      instanceId: "claude-sysprompt",
      displayName: "System Prompt Test",
      environment: { ARGV_LOG: sysArgvLog, MSG_LOG: sysMsgLog },
      enabled: true,
      config: ClaudeDriver.decodeConfig({ cli, fullAuto: true }),
    });

    await instance.adapter.sendTurn({ threadId: "thread-sys", text: "first", system: systemText });
    await instance.adapter.sendTurn({ threadId: "thread-sys", text: "second", system: systemText });

    const argv = await readJsonl(sysArgvLog) as string[][];
    assert.equal(argv.length, 1, "prompt flag is passed on the first spawn only");
    const flagIndex = argv[0].indexOf("--system-prompt");
    assert.ok(flagIndex >= 0, "first spawn must pass --system-prompt");
    assert.equal(argv[0][flagIndex + 1], systemText);
    assert.ok(argv[0].includes("--permission-mode") && argv[0].includes("bypassPermissions"));

    const messages = await readJsonl(sysMsgLog) as Array<{ message: { content: string } }>;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].message.content, "first");
    assert.equal(messages[1].message.content, "second");
    assert.equal(messages.filter((m) => m.message.content.includes(systemText)).length, 0,
      "framework prompt must not be duplicated into user text");

    await instance.adapter.stopAll();
    await instance.dispose();
  });
});
