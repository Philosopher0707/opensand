import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EventLogWriter, SessionEvent } from "@opensand/shared";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { UniversalLLMClient } from "../src/llm-client.js";
import { AgentCoordinator } from "../src/coordinator.js";
import { TranscriptManager } from "../src/transcript-manager.js";
import {
  EVENT,
  projectMessages,
  projectTranscriptText,
  projectTranscriptJsonl,
} from "../src/event-projections.js";
import type { TurnEvent } from "../src/types.js";

describe("Projection holes regression", () => {
  let tempDir: string;
  let daemon: LocalExecDaemon;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-holes-test-"));
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

  it("projectTranscriptText and writeProjections do not throw when event log starts with turn.started and has turn.folded index past the end", async () => {
    const sessionId = "holes-log-test";
    const tm = new TranscriptManager(sessionId, path.join(tempDir, "sessions"));
    await tm.ensureDirectory();

    const writer = new EventLogWriter(tm.directory, { sessionId });
    await writer.append({
      kind: EVENT.turnStarted,
      data: { message: { role: "user", content: "query without baseline" } },
    });
    await writer.append({
      kind: EVENT.turnFolded,
      data: {
        changes: [
          {
            index: 386,
            message: { role: "tool", tool_call_id: "c1", content: "folded tool result" },
          },
        ],
      },
    });

    const events: SessionEvent[] = await (tm as any).readEvents();
    assert.doesNotThrow(() => {
      const text = projectTranscriptText(events);
      assert.ok(typeof text === "string");
    });

    await assert.doesNotReject(async () => {
      await tm.writeProjections();
    });

    const messages = projectMessages(events);
    for (let i = 0; i < messages.length; i++) {
      assert.notEqual(messages[i], undefined, `messages[${i}] should not be undefined hole`);
    }
  });

  it("drives runTurn with a fake LLM client over a transcript starting with turn.started and out-of-bounds turn.folded", async () => {
    const sessionId = "holes-coordinator-test";
    const tm = new TranscriptManager(sessionId, path.join(tempDir, "sessions"));
    await tm.ensureDirectory();

    const writer = new EventLogWriter(tm.directory, { sessionId });
    await writer.append({
      kind: EVENT.turnStarted,
      data: { message: { role: "user", content: "prior turn" } },
    });
    await writer.append({
      kind: EVENT.turnFolded,
      data: {
        changes: [
          {
            index: 386,
            message: { role: "tool", tool_call_id: "c1", content: "folded tool result" },
          },
        ],
      },
    });

    const fakeFetch = async (): Promise<Response> => {
      const encoder = new TextEncoder();
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Assistant reply to turn." } }] })}\n\n`,
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

    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: fakeFetch,
    });

    const eventsEmitted: TurnEvent[] = [];
    const coordinator = new AgentCoordinator({
      llmClient: client,
      daemon,
      sessionId,
      sessionsBaseDir: path.join(tempDir, "sessions"),
      onEvent: (e) => eventsEmitted.push(e),
    });

    const answer = await coordinator.runTurn("Next turn query");
    assert.equal(answer, "Assistant reply to turn.");

    const completed = eventsEmitted.find((e) => e.type === "turn_completed");
    assert.ok(completed, "turn_completed must be emitted");
    assert.equal((completed as any).finalContent, "Assistant reply to turn.");
  });
});
