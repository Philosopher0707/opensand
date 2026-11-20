import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { AntigravityDriver } from "../src/providers/antigravity-driver.js";
import { FAKE_ACP, readJsonl, writeFakeCli } from "./helpers/fake-cli.js";

describe("AntigravityDriver", () => {
  let tmpDir: string;
  let cli: string;
  let argvLog: string;
  let msgLog: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-antigravity-test-"));
    cli = await writeFakeCli(tmpDir, "fake-agy", FAKE_ACP);
    argvLog = path.join(tmpDir, "argv.jsonl");
    msgLog = path.join(tmpDir, "msg.jsonl");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("decodes config and exposes metadata", () => {
    assert.deepEqual(AntigravityDriver.decodeConfig({}), { cli: "agy", fullAuto: false });
    assert.equal(AntigravityDriver.driverKind, "antigravity");
    assert.equal(AntigravityDriver.metadata.displayName, "Google Gemini (Antigravity)");
    assert.equal(AntigravityDriver.models.default, "gemini-3.8-flash");
  });

  it("creates an instance with expected shape", async () => {
    const instance = await AntigravityDriver.create({
      instanceId: "antigravity-1",
      displayName: "Antigravity Test",
      environment: {},
      enabled: true,
      config: AntigravityDriver.decodeConfig({ cli }),
    });
    const snap = await instance.snapshot();
    assert.equal(snap.instanceId, "antigravity-1");
    assert.equal(snap.driverKind, "antigravity");
    assert.equal(instance.adapter.provider, "antigravity");
    await instance.dispose();
  });

  it("spawns the ACP server, applies yolo mode and completes a turn", { timeout: 15_000 }, async () => {
    const instance = await AntigravityDriver.create({
      instanceId: "antigravity-proto",
      displayName: "Protocol Test",
      environment: { ARGV_LOG: argvLog, MSG_LOG: msgLog },
      enabled: true,
      config: AntigravityDriver.decodeConfig({ cli, fullAuto: true }),
    });

    const result = await instance.adapter.sendTurn({ threadId: "thread-1", text: "hello" });
    assert.equal((result as { text: string }).text, "hello");

    const argv = await readJsonl(argvLog) as string[][];
    assert.deepEqual(argv[0], [], "Antigravity's ACP server takes no CLI args");

    const messages = await readJsonl(msgLog) as Array<{ id?: number; method: string; params?: Record<string, unknown> }>;
    assert.equal(messages[0].method, "initialize");
    const mode = messages.find((m) => m.method === "session/set_config_option" && m.params?.configId === "mode");
    assert.equal(mode?.params?.value, "yolo");
    assert.ok(messages.some((m) => m.method === "session/prompt"));

    await instance.adapter.stopAll();
    await instance.dispose();
  });
});
