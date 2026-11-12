import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventLogReader, EventLogWriter } from "@opensand/shared";
import { EngineProcess, removeDir, tempDir, type WireFrame } from "./helpers.js";
import { logDirFor } from "../src/reconnect.js";

async function writeEvents(dir: string, count: number, sessionId = "s1"): Promise<void> {
  const writer = new EventLogWriter(path.join(dir, "sessions", sessionId), { sessionId });
  for (let index = 1; index <= count; index += 1) {
    await writer.append({
      kind: "tool.completed",
      data: { index, output: "line one\nline two" },
    });
  }
}

function replayed(engine: EngineProcess): WireFrame[] {
  return engine.frames.filter((frame) => frame.event !== undefined);
}

describe("engine reconnect", () => {
  it("replays exactly the events after lastSeq, in order, then answers", async () => {
    const dir = tempDir("reconnect");
    await writeEvents(dir, 50);
    const engine = new EngineProcess(dir);
    try {
      const response = await engine.request("req-1", "engine.Engine.reconnect", {
        sessionId: "s1",
        lastSeq: 20,
      });

      const frames = replayed(engine);
      assert.equal(frames.length, 30, "expected records 21..50");
      assert.deepEqual(
        frames.map((frame) => frame.seq),
        Array.from({ length: 30 }, (_, index) => index + 21)
      );
      frames.forEach((frame, index) => {
        assert.equal((frame.data as { index: number }).index, index + 21, "payload order");
        assert.ok(frame.ts && !Number.isNaN(Date.parse(frame.ts)), "ts is ISO-8601");
      });
      assert.equal((frames[0].data as { output: string }).output, "line one\nline two");

      assert.deepEqual(response.result, { replayedEvents: 30, currentSeq: 50 });

      const chain = await new EventLogReader(path.join(dir, "sessions", "s1")).verifyChain();
      assert.equal(chain.valid, true);
      assert.equal(chain.totalEvents, 50);
    } finally {
      await engine.kill();
      removeDir(dir);
    }
  });

  it("returns 4004 when lastSeq is beyond the head", async () => {
    const dir = tempDir("beyond");
    await writeEvents(dir, 5);
    const engine = new EngineProcess(dir);
    try {
      const response = await engine.request("req-1", "engine.Engine.reconnect", {
        sessionId: "s1",
        lastSeq: 6,
      });
      assert.equal(response.error?.code, 4004);
      assert.deepEqual(response.error?.data, { lastSeq: 6, currentSeq: 5 });
      assert.equal(replayed(engine).length, 0);
    } finally {
      await engine.kill();
      removeDir(dir);
    }
  });

  it("rejects reconnect without exactly one target and a valid lastSeq", async () => {
    const dir = tempDir("params");
    const engine = new EngineProcess(dir);
    try {
      const neither = await engine.request("req-1", "engine.Engine.reconnect", { lastSeq: 0 });
      assert.equal(neither.error?.code, -32602);
      const both = await engine.request("req-2", "engine.Engine.reconnect", {
        sessionId: "s1",
        missionId: "m1",
        lastSeq: 0,
      });
      assert.equal(both.error?.code, -32602);
      const negative = await engine.request("req-3", "engine.Engine.reconnect", {
        sessionId: "s1",
        lastSeq: -1,
      });
      assert.equal(negative.error?.code, -32602);
    } finally {
      await engine.kill();
      removeDir(dir);
    }
  });

  it("keeps the log after SIGKILL and replays it from a fresh process", async () => {
    const dir = tempDir("killrestart");
    await writeEvents(dir, 50);

    const first = new EngineProcess(dir);
    await first.request("req-1", "engine.Engine.ping");
    assert.equal(await first.kill("SIGKILL"), null);

    const second = new EngineProcess(dir);
    try {
      const response = await second.request("req-1", "engine.Engine.reconnect", {
        sessionId: "s1",
        lastSeq: 20,
      });
      const seqs = replayed(second).map((frame) => frame.seq);
      assert.equal(seqs.length, 30);
      assert.deepEqual(seqs, Array.from({ length: 30 }, (_, index) => index + 21));
      assert.deepEqual(response.result, { replayedEvents: 30, currentSeq: 50 });
    } finally {
      await second.kill();
      removeDir(dir);
    }
  });

  it("drops a torn trailing line instead of replaying or failing", async () => {
    const dir = tempDir("torn");
    await writeEvents(dir, 50);
    fs.appendFileSync(path.join(dir, "sessions", "s1", "event-log.jsonl"), '{"seq":51,"kind":"tool.completed"');

    const engine = new EngineProcess(dir);
    try {
      const response = await engine.request("req-1", "engine.Engine.reconnect", {
        sessionId: "s1",
        lastSeq: 40,
      });
      assert.deepEqual(response.result, { replayedEvents: 10, currentSeq: 50 });
      assert.deepEqual(
        replayed(engine).map((frame) => frame.seq),
        [41, 42, 43, 44, 45, 46, 47, 48, 49, 50]
      );
    } finally {
      await engine.kill();
      removeDir(dir);
    }
  });

  it("resolves session and mission logs under the injected state root", () => {
    assert.equal(logDirFor("/state", "session", "s1"), path.join("/state", "sessions", "s1"));
    assert.equal(logDirFor("/state", "mission", "m1"), path.join("/state", "missions", "m1"));
    assert.throws(() => logDirFor("/state", "session", "../escape"), /plain/);
  });
});
