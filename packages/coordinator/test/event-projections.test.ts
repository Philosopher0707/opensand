import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EventLogReader, SessionEvent, migrateSessionFolder } from "@opensand/shared";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { UniversalLLMClient } from "../src/llm-client.js";
import { AgentCoordinator } from "../src/coordinator.js";
import { TranscriptManager } from "../src/transcript-manager.js";
import {
  EVENT,
  formatHumanReadable,
  projectMessages,
  projectMetadata,
  projectTranscriptJsonl,
  projectTranscriptText,
} from "../src/event-projections.js";
import type { ChatMessage } from "../src/types.js";

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function ev(seq: number, kind: string, data: Record<string, unknown>, ts?: string): SessionEvent {
  return {
    seq,
    ts: ts ?? `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    sessionId: "s1",
    attempt: 1,
    node: "act",
    kind,
    data,
    prev: "",
  };
}

function textReply(reply: (userContent: string) => string) {
  return async (_url: any, init: any): Promise<Response> => {
    const payload = JSON.parse(init.body as string);
    const userMsg = payload.messages.filter((m: any) => m.role === "user").pop();
    const encoder = new TextEncoder();
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: reply(userMsg.content) } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
}

describe("projectMessages", () => {
  it("replays snapshot, turns, tool results and completions in order", () => {
    const events = [
      ev(1, EVENT.snapshot, { messages: [{ role: "system", content: "sys" }] }),
      ev(2, EVENT.turnStarted, { message: { role: "user", content: "hi" } }),
      ev(3, EVENT.modelCompletion, {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
      }),
      ev(4, EVENT.toolCompleted, { message: { role: "tool", tool_call_id: "c1", content: "ok" } }),
      ev(5, EVENT.modelCompletion, { message: { role: "assistant", content: "done" } }),
    ];

    assert.equal(projectMessages(events).length, 5);
    assert.deepEqual(projectMessages(events).map((m) => m.role), ["system", "user", "assistant", "tool", "assistant"]);
    assert.equal(projectMessages(events)[4].content, "done");
  });

  it("replaces an existing system prompt and inserts one when absent", () => {
    const replaced = projectMessages([
      ev(1, EVENT.system, { content: "A" }),
      ev(2, EVENT.turnStarted, { message: { role: "user", content: "x" } }),
      ev(3, EVENT.system, { content: "B" }),
    ]);
    assert.deepEqual(replaced, [
      { role: "system", content: "B" },
      { role: "user", content: "x" },
    ]);

    const inserted = projectMessages([
      ev(1, EVENT.turnStarted, { message: { role: "user", content: "u" } }),
      ev(2, EVENT.system, { content: "C" }),
    ]);
    assert.deepEqual(inserted, [
      { role: "system", content: "C" },
      { role: "user", content: "u" },
    ]);
  });

  it("applies a fold change at its index without moving other messages", () => {
    const messages = projectMessages([
      ev(1, EVENT.snapshot, {
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "u" },
          { role: "tool", tool_call_id: "c1", content: "very long output" },
          { role: "assistant", content: "after" },
        ],
      }),
      ev(2, EVENT.turnFolded, {
        changes: [{ index: 2, message: { role: "tool", tool_call_id: "c1", content: "[folded]" } }],
      }),
    ]);
    assert.equal(messages.length, 4);
    assert.equal(messages[2].content, "[folded]");
    assert.equal(messages[3].content, "after");
  });

  it("truncates history to keepLength on rollback", () => {
    const messages = projectMessages([
      ev(1, EVENT.snapshot, {
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" },
          { role: "assistant", content: "a2" },
        ],
      }),
      ev(2, EVENT.turnRollback, { keepLength: 3, turnsRolledBack: 1, removedMessages: 2 }),
    ]);
    assert.deepEqual(messages, [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ]);
  });

  it("keeps the system prompt and the tail from keepFrom, with the summary in between", () => {
    const messages = projectMessages([
      ev(1, EVENT.snapshot, {
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" },
          { role: "assistant", content: "a2" },
          { role: "user", content: "u3" },
          { role: "assistant", content: "a3" },
        ],
      }),
      ev(2, EVENT.turnCompacted, { keepFrom: 5, summary: "S", compactedTurns: 2 }),
    ]);
    assert.deepEqual(messages, [
      { role: "system", content: "sys" },
      { role: "system", content: "S" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ]);
  });

  it("returns an empty history for an empty log", () => {
    assert.deepEqual(projectMessages([]), []);
  });
});

describe("projection outputs", () => {
  const events = [
    ev(1, EVENT.sessionCreated, { model: "gpt-x" }, "2026-01-01T00:00:01.000Z"),
    ev(2, EVENT.snapshot, { messages: [{ role: "system", content: "sys" }] }, "2026-01-01T00:00:02.000Z"),
    ev(3, EVENT.turnStarted, { message: { role: "user", content: "q".repeat(100) } }, "2026-01-01T00:00:03.000Z"),
    ev(4, EVENT.modelCompletion, { message: { role: "assistant", content: "answer" } }, "2026-01-01T00:00:09.000Z"),
  ];

  it("derives metadata from the creation record and the first user message", () => {
    const meta = projectMetadata(events);
    assert.equal(meta.sessionId, "s1");
    assert.equal(meta.createdAt, "2026-01-01T00:00:01.000Z");
    assert.equal(meta.updatedAt, "2026-01-01T00:00:09.000Z");
    assert.equal(meta.model, "gpt-x");
    assert.equal(meta.endpoint, "");
    assert.equal(meta.title, "q".repeat(80));
  });

  it("applies session.renamed in projectMetadata to update the title", () => {
    const renamedEvents = [
      ...events,
      ev(5, EVENT.sessionRenamed, { title: "Custom Session Title" }, "2026-01-01T00:00:15.000Z"),
    ];
    const meta = projectMetadata(renamedEvents);
    assert.equal(meta.title, "Custom Session Title");
    assert.equal(meta.updatedAt, "2026-01-01T00:00:15.000Z");
  });

  it("writes only non-system messages to the legacy jsonl projection", () => {
    const lines = projectTranscriptJsonl(events).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((l) => l.role),
      ["user", "assistant"]
    );
    assert.equal(lines[1].timestamp, "2026-01-01T00:00:09.000Z");
    assert.equal(lines[1].sessionId, "s1");
  });

  it("keeps restore-point records in the legacy jsonl and out of the messages", () => {
    const withRestores = [
      ...events,
      ev(20, EVENT.restorePoint, { restorePoint: { id: "s1_1", filesCount: 2 } }, "2026-01-01T00:00:20.000Z"),
      ev(21, EVENT.restore, { restorePointId: "s1_1", result: { restored: 2 } }, "2026-01-01T00:00:21.000Z"),
    ];
    const lines = projectTranscriptJsonl(withRestores).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.slice(-2).map((l) => l.event), ["restore_point", "restore"]);
    assert.deepEqual(lines[lines.length - 2].restorePoint, { id: "s1_1", filesCount: 2 });
    assert.deepEqual(projectMessages(withRestores), projectMessages(events));
  });

  it("renders the human-readable transcript from the projected messages", () => {
    const text = projectTranscriptText(events);
    assert.equal(text, formatHumanReadable(projectMessages(events)));
    assert.match(text, /<user_query>\nq+\n<\/user_query>/);
    assert.match(text, /assistant:\nanswer/);
  });
});

describe("TranscriptManager event log", () => {
  let baseDir: string;

  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-proj-test-"));
  });

  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("loads exactly the messages the recorded events project to", async () => {
    const tm = new TranscriptManager("roundtrip", baseDir);
    const start: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    await tm.recordBaseline(start, { model: "m" });
    await tm.recordEvent(EVENT.modelCompletion, { message: { role: "assistant", content: "hello" } });

    const events = await new EventLogReader(tm.directory).readAll();
    const loaded = await tm.loadHistory();
    assert.deepEqual(loaded, projectMessages(events));
    assert.deepEqual(loaded, [...start, { role: "assistant", content: "hello" }]);
  });

  it("migrates a legacy transcript.jsonl into the event log without changing history", async () => {
    const tm = new TranscriptManager("legacy-migration", baseDir);
    await fs.mkdir(tm.directory, { recursive: true });
    await fs.writeFile(
      path.join(tm.directory, "transcript.jsonl"),
      [
        JSON.stringify({ role: "system", content: "sys" }),
        JSON.stringify({ role: "user", content: "hi" }),
        JSON.stringify({ role: "assistant", content: "hello" }),
        JSON.stringify({ role: "tool", tool_call_id: "c1", result: "ok" }),
      ].join("\n") + "\n"
    );

    const legacy = await tm.loadHistory();
    assert.equal(legacy.length, 4);

    await tm.recordBaseline(legacy, { model: "m" });
    const migrated = await tm.loadHistory();
    assert.deepEqual(plain(migrated), plain(legacy));

    const kinds = (await new EventLogReader(tm.directory).readAll()).map((e) => e.kind);
    assert.deepEqual(kinds, [EVENT.sessionCreated, EVENT.snapshot]);
  });

  it("v2 migration: projectMessages over migrated log deep-equals legacy messages.json", async () => {
    const sessDir = path.join(baseDir, "v2-legacy-equality");
    await fs.mkdir(sessDir, { recursive: true });
    const legacyMeta = { sessionId: "v2-legacy-equality", model: "model-v2", createdAt: "2026-01-01T10:00:00.000Z" };
    const legacyMsgs: ChatMessage[] = [
      { role: "system", content: "system instructions" },
      { role: "user", content: "initial query" },
      { role: "assistant", content: "agent response", tool_calls: [{ id: "call_1", type: "function", function: { name: "edit_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "file updated" },
    ];

    await fs.writeFile(path.join(sessDir, "meta.json"), JSON.stringify(legacyMeta, null, 2));
    await fs.writeFile(path.join(sessDir, "messages.json"), JSON.stringify(legacyMsgs, null, 2));

    const rep = migrateSessionFolder(sessDir);
    assert.equal(rep.status, "migrated");

    const reader = new EventLogReader(sessDir);
    const events = await reader.readAll();
    assert.equal(events.length, 2);
    assert.deepEqual(projectMessages(events), legacyMsgs);
  });

  it("v2 migration: session migrated by v2 and opened by TranscriptManager neither appends a second baseline nor breaks the chain", async () => {
    const sessDir = path.join(baseDir, "v2-tm-open");
    await fs.mkdir(sessDir, { recursive: true });
    const legacyMeta = { sessionId: "v2-tm-open", model: "test-model-m", createdAt: "2026-01-01T10:00:00.000Z" };
    const legacyMsgs: ChatMessage[] = [
      { role: "system", content: "sys prompt" },
      { role: "user", content: "user turn" },
      { role: "assistant", content: "reply turn" },
    ];

    await fs.writeFile(path.join(sessDir, "meta.json"), JSON.stringify(legacyMeta, null, 2));
    await fs.writeFile(path.join(sessDir, "messages.json"), JSON.stringify(legacyMsgs, null, 2));

    const rep = migrateSessionFolder(sessDir);
    assert.equal(rep.status, "migrated");

    // Open with TranscriptManager
    const tm = new TranscriptManager("v2-tm-open", baseDir);
    const loaded = await tm.loadHistory();
    assert.deepEqual(plain(loaded), plain(legacyMsgs));

    // Call recordBaseline - should NOT append a second baseline
    await tm.recordBaseline(loaded, { model: "test-model-m" });
    const reader = new EventLogReader(sessDir);
    const eventsAfterBaseline = await reader.readAll();
    assert.equal(eventsAfterBaseline.length, 2, "must not append second baseline");

    // Continue recording events on the live session
    await tm.recordEvent(EVENT.modelCompletion, { message: { role: "assistant", content: "post-migration turn" } });
    const eventsAfterNewTurn = await reader.readAll();
    assert.equal(eventsAfterNewTurn.length, 3);
    assert.equal(eventsAfterNewTurn[2].seq, 3);

    const verification = await reader.verifyChain();
    assert.equal(verification.valid, true);
    assert.equal(verification.totalEvents, 3);
  });

  it("falls back to messages.json on a broken chain and refuses further appends", async () => {
    const tm = new TranscriptManager("tampered", baseDir);
    await tm.recordBaseline([{ role: "system", content: "sys" }], { model: "m" });
    await tm.recordEvent(EVENT.modelCompletion, { message: { role: "assistant", content: "hello" } });
    await tm.writeProjections();
    const expected = await tm.loadHistory();

    const logPath = path.join(tm.directory, "event-log.jsonl");
    const raw = await fs.readFile(logPath, "utf8");
    await fs.writeFile(logPath, raw.replace('"model":"m"', '"model":"X"'));

    const { messages, report } = await tm.loadHistoryDetailed();
    assert.deepEqual(messages, expected);
    assert.ok(report.warnings.some((w) => w.type === "corrupt_line_skipped"));

    await assert.rejects(tm.recordEvent(EVENT.modelCompletion, { message: { role: "assistant", content: "x" } }));
  });
});

describe("AgentCoordinator event log parity", () => {
  let tempDir: string;
  let daemon: LocalExecDaemon;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-parity-test-"));
    daemon = new LocalExecDaemon({
      stateDir: path.join(tempDir, "state"),
      heartbeatIntervalMs: 200,
    });
    await daemon.start();
  });

  after(async () => {
    await daemon.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeCoordinator(fetchImpl: any, sessionId: string) {
    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: fetchImpl,
    });
    return new AgentCoordinator({
      llmClient: client,
      daemon,
      sessionId,
      sessionsBaseDir: path.join(tempDir, "sessions"),
    });
  }

  async function assertProjectionsMatch(coordinator: AgentCoordinator) {
    const tm = new TranscriptManager(coordinator.sessionId, path.join(tempDir, "sessions"));
    const events = await new EventLogReader(tm.directory).readAll();
    const live = plain([...coordinator.history]);

    assert.deepEqual(plain(projectMessages(events)), live);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(tm.directory, "messages.json"), "utf8")), live);
    assert.equal(await fs.readFile(path.join(tm.directory, "transcript.txt"), "utf8"), formatHumanReadable(live));
    assert.equal(
      await fs.readFile(path.join(tm.directory, "transcript.jsonl"), "utf8"),
      projectTranscriptJsonl(events)
    );
    return events;
  }

  it("keeps every projection equal to live history across a tool turn", async () => {
    const outputPath = path.join(tempDir, "parity-output.txt");
    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      const payload = JSON.parse(init.body as string);
      const lastMsg = payload.messages[payload.messages.length - 1];
      const encoder = new TextEncoder();
      const chunks =
        lastMsg.role === "tool"
          ? [`data: ${JSON.stringify({ choices: [{ delta: { content: "Wrote it." } }] })}\n\n`, "data: [DONE]\n\n"]
          : [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      content: "Writing.",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_parity_1",
                          type: "function",
                          function: {
                            name: "write_file",
                            arguments: JSON.stringify({ path: outputPath, content: "parity" }),
                          },
                        },
                      ],
                    },
                  },
                ],
              })}\n\n`,
              "data: [DONE]\n\n",
            ];
      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const coordinator = makeCoordinator(mockFetch, "parity-tool-turn");
    const answer = await coordinator.runTurn("Please write the output file");
    assert.equal(answer, "Wrote it.");

    const events = await assertProjectionsMatch(coordinator);
    const kinds = new Set(events.map((e) => e.kind));
    for (const kind of [EVENT.turnStarted, EVENT.modelCompletion, EVENT.toolCompleted]) {
      assert.ok(kinds.has(kind), `expected a ${kind} event`);
    }
  });

  it("keeps projections equal to live history after rollback and compaction", async () => {
    const coordinator = makeCoordinator(
      textReply((q) => `Answer for ${q}`),
      "parity-rollback-compact"
    );
    await coordinator.runTurn("first question");
    await coordinator.runTurn("second question");
    await coordinator.runTurn("third question");

    await coordinator.rollbackTurns(1);
    await assertProjectionsMatch(coordinator);
    assert.ok(!coordinator.history.some((m) => m.content === "Answer for third question"));

    await coordinator.compactHistory({ keepRecentTurns: 1, customSummary: "Earlier turns summarized." });
    await assertProjectionsMatch(coordinator);
    assert.ok(
      coordinator.history.some((m) => m.role === "system" && m.content === "Earlier turns summarized.")
    );
  });
});
