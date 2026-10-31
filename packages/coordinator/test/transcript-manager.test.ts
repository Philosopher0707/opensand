import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { TranscriptManager } from "../src/transcript-manager.js";
import { ChatMessage } from "../src/types.js";

describe("TranscriptManager", () => {
  let tempDir: string;
  let manager: TranscriptManager;
  const sessionId = "test-session-123";

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-trans-test-"));
    manager = new TranscriptManager(sessionId, tempDir);
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("appends structured JSONL turn events", async () => {
    await manager.appendJsonl({ role: "user", content: "hello world" });
    await manager.appendJsonl({ role: "assistant", content: "hi there" });

    const content = await fs.readFile(path.join(manager.directory, "transcript.jsonl"), "utf-8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));

    assert.equal(lines.length, 2);
    assert.equal(lines[0].sessionId, sessionId);
    assert.equal(lines[0].content, "hello world");
    assert.equal(lines[1].content, "hi there");
  });

  it("formats human-readable transcripts with Grok Bot parity tags", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "System instructions" },
      { role: "user", content: "list files in workspace" },
      {
        role: "assistant",
        content: "Checking workspace...",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "exec_command",
              arguments: JSON.stringify({ command: "ls" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "file1.txt\nfile2.txt",
      },
      {
        role: "assistant",
        content: "I found file1.txt and file2.txt.",
      },
    ];

    const formatted = manager.formatHumanReadable(messages);

    assert.match(formatted, /<user_query>\nlist files in workspace\n<\/user_query>/);
    assert.match(formatted, /assistant:\nChecking workspace\.\.\./);
    assert.match(formatted, /\[Tool call\]\nTool: exec_command/);
    assert.match(formatted, /\[Tool result\]\nfile1\.txt\nfile2\.txt/);
    assert.match(formatted, /assistant:\nI found file1\.txt and file2\.txt\./);

    await manager.writeHumanReadableTranscript(messages);
    const saved = await fs.readFile(path.join(manager.directory, "transcript.txt"), "utf-8");
    assert.equal(saved, formatted);
  });
});
