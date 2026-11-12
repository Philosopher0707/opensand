import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EngineServer } from "../src/server.js";
import type { EngineConnection } from "../src/types.js";

class FakeConnection implements EngineConnection {
  readonly lines: string[] = [];
  buffered = 0;
  dropped = false;

  write(line: string): void {
    this.lines.push(line);
  }

  bufferedBytes(): number {
    return this.buffered;
  }

  drop(): void {
    this.dropped = true;
  }

  frames(): Array<Record<string, any>> {
    return this.lines.map((line) => JSON.parse(line));
  }
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("heartbeat and subscriptions", () => {
  it("sends heartbeats to subscribers only and drops a consumer past 4 MiB", async () => {
    const stderr: string[] = [];
    const subscriber = new FakeConnection();
    const bystander = new FakeConnection();
    const server = new EngineServer({
      stateDir: "/unused",
      version: "test",
      connection: subscriber,
      heartbeatIntervalMs: 20,
      stderr: (message) => stderr.push(message),
    });
    server.start();
    try {
      server.handleChunk(
        `${JSON.stringify({ id: "s", method: "inbox.Approvals.subscribe", params: {} })}\n`
      );
      await settle(80);

      const beats = subscriber.frames().filter((frame) => frame.event === "engine.Engine.heartbeat");
      assert.ok(beats.length >= 2, `expected heartbeats, got ${JSON.stringify(subscriber.frames())}`);
      beats.forEach((beat, index) => {
        assert.equal(beat.seq, index + 1);
        assert.equal(typeof beat.data.timestamp, "string");
        assert.ok(beat.data.uptimeMs >= 0);
      });
      assert.equal(bystander.frames().length, 0, "non-subscribers receive no events");

      subscriber.buffered = 4 * 1024 * 1024 + 1;
      const countBeforeDrop = beats.length;
      await settle(80);
      assert.equal(subscriber.dropped, true);
      assert.match(stderr.join("\n"), /dropped slow consumer/);

      subscriber.buffered = 0;
      await settle(60);
      const afterDrop = subscriber
        .frames()
        .filter((frame) => frame.event === "engine.Engine.heartbeat").length;
      assert.equal(afterDrop, countBeforeDrop, "a dropped connection receives no further events");
    } finally {
      await server.close();
    }
  });

  it("does not start heartbeat timers when the interval is zero", async () => {
    const connection = new FakeConnection();
    const server = new EngineServer({
      stateDir: "/unused",
      version: "test",
      connection,
      heartbeatIntervalMs: 0,
    });
    server.start();
    server.handleChunk(`${JSON.stringify({ id: "s", method: "inbox.Approvals.subscribe", params: {} })}\n`);
    await settle(40);
    assert.equal(connection.frames().filter((frame) => frame.event).length, 0);
    await server.close();
  });
});
