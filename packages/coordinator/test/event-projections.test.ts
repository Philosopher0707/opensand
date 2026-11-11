import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  EventLogWriter,
  EventLogReader,
  SessionEvent,
} from "@opensand/shared";
import {
  projectMessages,
  projectMetadata,
  projectHumanReadable,
  projectTranscriptJsonl,
} from "../src/event-projections.js";
import { TranscriptManager } from "../src/transcript-manager.js";

describe("Event Projections", () => {
  it("projects ChatMessage[] accurately from an event log stream", async () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        ts: "2026-11-11T18:00:00.000Z",
        sessionId: "sess-proj-1",
        kind: "session.created",
        data: { title: "Test Projection Session", model: "qwen3:8b" },
        prev: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
      {
        seq: 2,
        ts: "2026-11-11T18:00:01.000Z",
        sessionId: "sess-proj-1",
        kind: "turn.started",
        data: { role: "user", content: "Show me files" },
        prev: "sha256:dummy1",
      },
      {
        seq: 3,
        ts: "2026-11-11T18:00:02.000Z",
        sessionId: "sess-proj-1",
        kind: "model.completion",
        data: {
          role: "assistant",
          content: "Let me check...",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "list_files", arguments: '{"dir":"."}' },
            },
          ],
        },
        prev: "sha256:dummy2",
      },
      {
        seq: 4,
        ts: "2026-11-11T18:00:03.000Z",
        sessionId: "sess-proj-1",
        kind: "tool.completed",
        data: {
          role: "tool",
          tool_call_id: "call_1",
          result: "README.md\npackage.json",
        },
        prev: "sha256:dummy3",
      },
      {
        seq: 5,
        ts: "2026-11-11T18:00:04.000Z",
        sessionId: "sess-proj-1",
        kind: "model.completion",
        data: {
          role: "assistant",
          content: "Here are the files: README.md and package.json.",
        },
        prev: "sha256:dummy4",
      },
    ];

    const messages = projectMessages(events);
    assert.equal(messages.length, 4);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].content, "Show me files");
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].tool_calls?.[0].id, "call_1");
    assert.equal(messages[2].role, "tool");
    assert.equal(messages[2].content, "README.md\npackage.json");
    assert.equal(messages[3].role, "assistant");
    assert.equal(messages[3].content, "Here are the files: README.md and package.json.");

    const meta = projectMetadata(events);
    assert.equal(meta.sessionId, "sess-proj-1");
    assert.equal(meta.title, "Test Projection Session");
    assert.equal(meta.model, "qwen3:8b");
    assert.equal(meta.turnCount, 1);

    const txt = projectHumanReadable(events);
    assert.match(txt, /<user_query>\nShow me files\n<\/user_query>/);
    assert.match(txt, /assistant:\nLet me check\.\.\./);
    assert.match(txt, /\[Tool call\]\nTool: list_files/);
    assert.match(txt, /\[Tool result\]\nREADME\.md\npackage\.json/);

    const jsonl = projectTranscriptJsonl(events);
    assert.ok(jsonl.includes("Show me files"));
    assert.ok(jsonl.includes("call_1"));
  });

  it("TranscriptManager.regenerateProjections() produces all 4 legacy files from event-log.jsonl", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-regen-"));
    try {
      const sessionId = "sess-regen-test";
      const tm = new TranscriptManager(sessionId, tempDir);
      await tm.ensureDirectory();

      await tm.appendJsonl({ role: "user", content: "Initial prompt" });
      await tm.appendJsonl({ role: "assistant", content: "Understood" });

      // Delete existing projection files if any
      await fs.rm(path.join(tm.directory, "messages.json"), { force: true });
      await fs.rm(path.join(tm.directory, "metadata.json"), { force: true });
      await fs.rm(path.join(tm.directory, "transcript.txt"), { force: true });
      await fs.rm(path.join(tm.directory, "transcript.jsonl"), { force: true });

      // Regenerate projections from event-log.jsonl
      await tm.regenerateProjections();

      assert.equal(await fs.stat(path.join(tm.directory, "messages.json")).then(() => true).catch(() => false), true);
      assert.equal(await fs.stat(path.join(tm.directory, "metadata.json")).then(() => true).catch(() => false), true);
      assert.equal(await fs.stat(path.join(tm.directory, "transcript.txt")).then(() => true).catch(() => false), true);
      assert.equal(await fs.stat(path.join(tm.directory, "transcript.jsonl")).then(() => true).catch(() => false), true);

      const msgs = JSON.parse(await fs.readFile(path.join(tm.directory, "messages.json"), "utf8"));
      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].content, "Initial prompt");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
