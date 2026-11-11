import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  TranscriptManager,
  listSessions,
  writeAtomic,
  reconcileTurnInvariants,
} from "../src/transcript-manager.js";
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

  it("records turn events to event-log.jsonl and projects them to transcript.jsonl", async () => {
    await manager.recordEvent("turn.started", { message: { role: "user", content: "hello world" } });
    await manager.recordEvent("model.completion", { message: { role: "assistant", content: "hi there" } });
    await manager.writeProjections();

    const events = (await fs.readFile(path.join(manager.directory, "event-log.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(events.length, 2);
    assert.equal(events[0].sessionId, sessionId);
    assert.equal(events[0].kind, "turn.started");
    assert.equal(events[1].kind, "model.completion");

    const lines = (await fs.readFile(path.join(manager.directory, "transcript.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
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

    const formatManager = new TranscriptManager("format-session", tempDir);
    await formatManager.recordBaseline(messages, { model: "test-model" });
    await formatManager.writeProjections();
    const saved = await fs.readFile(path.join(formatManager.directory, "transcript.txt"), "utf-8");
    assert.equal(saved, formatted);

    const hydrated = await formatManager.loadHistory();
    assert.equal(hydrated.length, messages.length);
    assert.equal(hydrated[1].role, "user");
    assert.equal(hydrated[1].content, "list files in workspace");
    assert.equal(hydrated[2].role, "assistant");
    assert.equal(hydrated[2].tool_calls?.length, 1);
  });

  it("loads history by falling back to transcript.jsonl if messages.json is absent", async () => {
    const fallbackSessionId = "fallback-session-456";
    const fallbackManager = new TranscriptManager(fallbackSessionId, tempDir);

    await fs.mkdir(fallbackManager.directory, { recursive: true });
    const legacyEntries = [
      { role: "user", content: "first question" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_a", type: "function", function: { name: "test_tool", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_a", result: "tool output" },
      { role: "assistant", content: "final answer" },
    ];
    await fs.writeFile(
      path.join(fallbackManager.directory, "transcript.jsonl"),
      legacyEntries.map((e) => JSON.stringify(e) + "\n").join(""),
      "utf-8"
    );

    const loaded = await fallbackManager.loadHistory();
    assert.equal(loaded.length, 4);
    assert.equal(loaded[0].role, "user");
    assert.equal(loaded[0].content, "first question");
    assert.equal(loaded[1].role, "assistant");
    assert.equal(loaded[1].tool_calls?.[0].id, "call_a");
    assert.equal(loaded[2].role, "tool");
    assert.equal(loaded[2].content, "tool output");
    assert.equal(loaded[3].role, "assistant");
    assert.equal(loaded[3].content, "final answer");
  });

  it("discards unparseable truncated tail from interrupted writes and reports warning", async () => {
    const truncatedSessId = "sess-truncated-tail";
    const truncManager = new TranscriptManager(truncatedSessId, tempDir);
    await truncManager.ensureDirectory();

    // Line 1: valid user turn
    // Line 2: valid assistant turn
    // Line 3: truncated mid-write JSON line (simulating kill -9 mid-append)
    const jsonlContent = [
      JSON.stringify({ role: "user", content: "hello world" }),
      JSON.stringify({ role: "assistant", content: "greeting acknowledged" }),
      '{"role":"assistant","content":"partial text that was cut off mid-wri',
    ].join("\n");

    await fs.writeFile(path.join(truncManager.directory, "transcript.jsonl"), jsonlContent, "utf-8");

    const { messages, report } = await truncManager.loadHistoryDetailed();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, "hello world");
    assert.equal(messages[1].content, "greeting acknowledged");

    assert.equal(report.recoveredMessages, 2);
    assert.equal(report.discardedEntries, 1);
    assert.equal(report.warnings.length, 1);
    assert.equal(report.warnings[0].type, "truncated_tail_discarded");
    assert.equal(report.warnings[0].lineNumber, 3);
    assert.ok(report.warnings[0].rawSnippet?.includes("partial text"));
    assert.ok(report.warnings[0].remedy.includes("incomplete trailing line"));
  });

  it("skips corrupt mid-file lines, preserves valid surrounding entries, and records line warnings", async () => {
    const corruptSessId = "sess-corrupt-mid";
    const corruptManager = new TranscriptManager(corruptSessId, tempDir);
    await corruptManager.ensureDirectory();

    // Line 1: valid user turn
    // Line 2: corrupted mid-file line
    // Line 3: valid assistant turn
    // Line 4: valid user follow-up
    const jsonlContent = [
      JSON.stringify({ role: "user", content: "turn 1" }),
      '{INVALID_JSON_CORRUPT_BYTES}',
      JSON.stringify({ role: "assistant", content: "response 1" }),
      JSON.stringify({ role: "user", content: "turn 2" }),
    ].join("\n");

    await fs.writeFile(path.join(corruptManager.directory, "transcript.jsonl"), jsonlContent, "utf-8");

    const { messages, report } = await corruptManager.loadHistoryDetailed();
    assert.equal(messages.length, 3);
    assert.equal(messages[0].content, "turn 1");
    assert.equal(messages[1].content, "response 1");
    assert.equal(messages[2].content, "turn 2");

    assert.equal(report.recoveredMessages, 3);
    assert.equal(report.discardedEntries, 1);
    assert.equal(report.warnings.length, 1);
    assert.equal(report.warnings[0].type, "corrupt_line_skipped");
    assert.equal(report.warnings[0].lineNumber, 2);
    assert.ok(report.warnings[0].rawSnippet?.includes("INVALID_JSON"));
  });

  it("reconciles orphaned tool calls with matching stubbed tool responses and reports warning", async () => {
    const orphanSessId = "sess-orphaned-tools";
    const orphanManager = new TranscriptManager(orphanSessId, tempDir);
    await orphanManager.ensureDirectory();

    // Assistant called two tools (call_1 and call_2), but only call_1 completed before crash
    const jsonlContent = [
      JSON.stringify({ role: "user", content: "do some work" }),
      JSON.stringify({
        role: "assistant",
        content: "calling tools",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "readFile", arguments: '{"path":"a.txt"}' } },
          { id: "call_2", type: "function", function: { name: "executeCommand", arguments: '{"cmd":"npm test"}' } },
        ],
      }),
      JSON.stringify({ role: "tool", tool_call_id: "call_1", result: "file content" }),
      // Notice: tool result for call_2 is MISSING
    ].join("\n");

    await fs.writeFile(path.join(orphanManager.directory, "transcript.jsonl"), jsonlContent, "utf-8");

    const { messages, report } = await orphanManager.loadHistoryDetailed();
    assert.equal(messages.length, 4); // user, assistant, tool 1, tool 2 (stubbed)
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[2].role, "tool");
    assert.equal(messages[2].tool_call_id, "call_1");
    assert.equal(messages[2].content, "file content");

    assert.equal(messages[3].role, "tool");
    assert.equal(messages[3].tool_call_id, "call_2");
    assert.ok(messages[3].content?.includes("Execution interrupted"));

    assert.equal(report.recoveredMessages, 4);
    assert.ok(report.warnings.some((w) => w.type === "orphaned_tool_calls_reconciled"));
  });

  it("supports pruning strategy for orphaned tool calls", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "run task" },
      {
        role: "assistant",
        content: "starting",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "toolA", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "toolB", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "done A" },
    ];

    const { messages: reconciled, warnings } = reconcileTurnInvariants(messages, { strategy: "prune" });
    assert.equal(reconciled.length, 3);
    const assistant = reconciled[1];
    assert.equal(assistant.role, "assistant");
    assert.equal(assistant.tool_calls?.length, 1);
    assert.equal(assistant.tool_calls?.[0].id, "call_a");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].type, "orphaned_tool_calls_reconciled");
  });

  it("writeAtomic writes data atomically and replaces destination without partial states", async () => {
    const testFile = path.join(tempDir, "atomic-test.txt");
    await writeAtomic(testFile, "initial content");
    assert.equal(await fs.readFile(testFile, "utf-8"), "initial content");

    await writeAtomic(testFile, "updated content");
    assert.equal(await fs.readFile(testFile, "utf-8"), "updated content");

    // Also verify TranscriptManager's writeAtomic instance method
    await manager.writeAtomic("sub-file.json", JSON.stringify({ ok: true }));
    const saved = await fs.readFile(path.join(manager.directory, "sub-file.json"), "utf-8");
    assert.deepEqual(JSON.parse(saved), { ok: true });
  });

  it("listSessions on a mkdtemp dir returns newest-first, reads title/turns from messages.json, ignores empty dirs, returns [] for missing dir", async () => {
    const missingDir = path.join(tempDir, "does-not-exist");
    const missingResult = await listSessions(missingDir);
    assert.deepEqual(missingResult, []);

    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-listsessions-test-"));
    try {
      // 1. Session A: older
      const sessADir = path.join(baseDir, "session_a");
      await fs.mkdir(sessADir, { recursive: true });
      const msgsA = [
        { role: "user", content: "What is the capital of France?" },
        { role: "assistant", content: "Paris" },
      ];
      await fs.writeFile(path.join(sessADir, "messages.json"), JSON.stringify(msgsA));
      await fs.writeFile(path.join(sessADir, "transcript.jsonl"), JSON.stringify({ role: "user", content: "hello" }) + "\n");
      const pastTime = new Date(Date.now() - 60000);
      await fs.utimes(path.join(sessADir, "transcript.jsonl"), pastTime, pastTime);

      // 2. Session B: newer
      const sessBDir = path.join(baseDir, "session_b");
      await fs.mkdir(sessBDir, { recursive: true });
      const msgsB = [
        { role: "user", content: "Implement session resume feature in OpenSand" },
        { role: "assistant", content: "Working on it" },
        { role: "user", content: "Also add tab completion" },
        { role: "assistant", content: "Done" },
      ];
      await fs.writeFile(path.join(sessBDir, "messages.json"), JSON.stringify(msgsB));
      await fs.writeFile(path.join(sessBDir, "transcript.jsonl"), JSON.stringify({ role: "user", content: "test" }) + "\n");

      // 3. Directory with no transcript (empty dir)
      const emptyDir = path.join(baseDir, "empty_session");
      await fs.mkdir(emptyDir, { recursive: true });

      const sessions = await listSessions(baseDir);
      assert.equal(sessions.length, 2);
      assert.equal(sessions[0].sessionId, "session_b");
      assert.equal(sessions[0].title, "Implement session resume feature in OpenSand");
      assert.equal(sessions[0].turns, 2);

      assert.equal(sessions[1].sessionId, "session_a");
      assert.equal(sessions[1].title, "What is the capital of France?");
      assert.equal(sessions[1].turns, 1);

      // 4. Corrupt messages.json must still be listed: loadHistory falls back to transcript.jsonl
      const corruptDir = path.join(baseDir, "corrupt_session");
      await fs.mkdir(corruptDir, { recursive: true });
      await fs.writeFile(path.join(corruptDir, "messages.json"), "{not json");
      await fs.writeFile(path.join(corruptDir, "transcript.jsonl"), JSON.stringify({ role: "user" }) + "\n");
      const withCorrupt = await listSessions(baseDir);
      const corrupt = withCorrupt.find((s) => s.sessionId === "corrupt_session");
      assert.ok(corrupt, "corrupt session should still be listed");
      assert.equal(corrupt.title, undefined);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});
