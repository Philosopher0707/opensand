import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ClaudeDriver } from "../src/providers/claude-driver.js";
import { OpenCodeDriver } from "../src/providers/opencode-driver.js";
import { CodexDriver } from "../src/providers/codex-driver.js";
import { FAKE_CLAUDE_TOOLS, FAKE_ACP_TOOLS, FAKE_CODEX_TOOLS, writeFakeCli } from "./helpers/fake-cli.js";

describe("CLI turns expose tool events", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-tool-events-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("Claude stream-json tool_use becomes a tool.call event", { timeout: 20_000 }, async () => {
    const cli = await writeFakeCli(tmpDir, "claude-tools", FAKE_CLAUDE_TOOLS);
    const instance = await ClaudeDriver.create({
      instanceId: "tools-claude", displayName: "Tools", environment: {}, enabled: true,
      config: ClaudeDriver.decodeConfig({ cli }),
    });
    const events: Array<Record<string, unknown>> = [];
    instance.adapter.onEvent((event) => events.push(event as Record<string, unknown>));
    const result = await instance.adapter.sendTurn({ threadId: "t", text: "hi" });
    assert.equal((result as { text: string }).text, "hello");
    assert.ok(events.some((e) => e.type === "tool.call" && e.name === "read_file"));
    await instance.dispose();
  });

  it("ACP tool_call notification becomes a tool.call event", { timeout: 20_000 }, async () => {
    const cli = await writeFakeCli(tmpDir, "acp-tools", FAKE_ACP_TOOLS);
    const instance = await OpenCodeDriver.create({
      instanceId: "tools-acp", displayName: "Tools", environment: {}, enabled: true,
      config: OpenCodeDriver.decodeConfig({ cli }),
    });
    const events: Array<Record<string, unknown>> = [];
    instance.adapter.onEvent((event) => events.push(event as Record<string, unknown>));
    const result = await instance.adapter.sendTurn({ threadId: "t", text: "hi" });
    assert.equal((result as { text: string }).text, "hello");
    assert.ok(events.some((e) => e.type === "tool.call"));
    await instance.dispose();
  });

  it("Codex item events become tool.call and tool.result events", { timeout: 20_000 }, async () => {
    const cli = await writeFakeCli(tmpDir, "codex-tools", FAKE_CODEX_TOOLS);
    const instance = await CodexDriver.create({
      instanceId: "tools-codex", displayName: "Tools", environment: {}, enabled: true,
      config: CodexDriver.decodeConfig({ cli, fullAuto: true }),
    });
    const events: Array<Record<string, unknown>> = [];
    instance.adapter.onEvent((event) => events.push(event as Record<string, unknown>));
    const result = await instance.adapter.sendTurn({ threadId: "t", text: "hi" });
    assert.equal((result as { text: string }).text, "hello");
    assert.ok(events.some((e) => e.type === "tool.call"));
    assert.ok(events.some((e) => e.type === "tool.result"));
    await instance.dispose();
  });
});
