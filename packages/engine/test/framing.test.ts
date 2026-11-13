import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { EventLogWriter } from "@opensand/shared";
import { EngineProcess, removeDir, tempDir } from "./helpers.js";

describe("engine stdio framing", () => {
  it("parses a request split into one-byte writes", async () => {
    const dir = tempDir("split");
    const engine = new EngineProcess(dir);
    try {
      const line = `${JSON.stringify({ id: "split-1", method: "engine.Engine.ping", params: {} })}\n`;
      for (const byte of line) engine.child.stdin.write(byte);
      const response = await engine.waitFor((frame) => frame.id === "split-1");
      assert.equal(typeof (response.result as { timestamp: string }).timestamp, "string");
    } finally {
      await engine.kill();
      removeDir(dir);
    }
  });

  it("answers concurrent requests with their own ids", async () => {
    const dir = tempDir("concurrent");
    const engine = new EngineProcess(dir);
    try {
      engine.send({ id: "a", method: "engine.Engine.ping", params: {} });
      engine.send({ id: "b", method: "engine.Engine.status", params: {} });
      const [a, b] = await Promise.all([
        engine.waitFor((frame) => frame.id === "a"),
        engine.waitFor((frame) => frame.id === "b"),
      ]);
      assert.ok("timestamp" in (a.result as object));
      assert.ok("version" in (b.result as object));
    } finally {
      await engine.kill();
      removeDir(dir);
    }
  });

  it("keeps every stdout line a single parseable frame, even with newlines in payloads", async () => {
    const dir = tempDir("purity");
    const writer = new EventLogWriter(path.join(dir, "sessions", "s1"), { sessionId: "s1" });
    await writer.append({ kind: "tool.completed", data: { stdout: "first\nsecond\nthird" } });

    const engine = new EngineProcess(dir);
    try {
      engine.child.stdin.write("{not json\n");
      await engine.request("req-1", "engine.Engine.reconnect", { sessionId: "s1", lastSeq: 0 });
      await engine.request("req-2", "engine.Engine.ping");

      assert.ok(engine.frames.length >= 4);
      assert.deepEqual(engine.invalidLines, [], "stdout carried a non-frame line");
      assert.equal(engine.rawLines.length, engine.frames.length, "every stdout line parses as a frame");
      for (const frame of engine.frames) {
        assert.ok(frame.id !== undefined || frame.event !== undefined, "every line is a response or event");
      }
      const replayed = engine.frames.find((frame) => frame.event !== undefined);
      assert.equal((replayed?.data as { stdout: string }).stdout, "first\nsecond\nthird");
    } finally {
      await engine.kill();
      removeDir(dir);
    }
  });

  it("answers unimplemented session methods with -32601 and mission methods without an agent", async () => {
    const dir = tempDir("stubs");
    const engine = new EngineProcess(dir);
    try {
      const session = await engine.request("req-1", "session.Sessions.list");
      assert.equal(session.error?.code, -32601);
      const mission = await engine.request("req-2", "mission.Missions.start", {
        workspaceRoot: dir,
        title: "t",
        initialQuery: "q",
        checkCommand: "true",
      });
      assert.equal(mission.error?.code, -32600);
      assert.equal(mission.error?.message, "no mission agent configured");
      const unknown = await engine.request("req-3", "bogus.Bogus.nope");
      assert.equal(unknown.error?.code, -32601);
      const subscribe = await engine.request("req-4", "mission.Missions.subscribe", {
        missionId: "m1",
      });
      assert.deepEqual(subscribe.result, { subscribed: true, currentSeq: 0 });
    } finally {
      await engine.kill();
      removeDir(dir);
    }
  });
});
