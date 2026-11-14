import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EngineServer } from "../src/server.js";
import type { EngineConnection } from "../src/types.js";

class FakeConnection implements EngineConnection {
  readonly lines: string[] = [];
  buffered = 0;
  dropped = false;

  private readonly waiters: Array<() => void> = [];

  write(line: string): void {
    this.lines.push(line);
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** Resolves once a written frame satisfies `predicate`; no clock involved. */
  async waitForFrame(predicate: (frame: Record<string, any>) => boolean): Promise<void> {
    while (!this.frames().some(predicate)) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
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

const beatsOf = (connection: FakeConnection) =>
  connection.frames().filter((frame) => frame.event === "engine.Engine.heartbeat");

describe("heartbeat and subscriptions", () => {
  it("sends heartbeats to subscribers only and drops a consumer past 4 MiB", async (t) => {
    // The heartbeat interval is driven by hand: each tick() is exactly one beat, so nothing
    // depends on how fast the machine runs.
    t.mock.timers.enable({ apis: ["setInterval"] });
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
      await subscriber.waitForFrame((frame) => frame.id === "s");

      t.mock.timers.tick(20);
      t.mock.timers.tick(20);

      const beats = beatsOf(subscriber);
      assert.equal(beats.length, 2, `expected exactly two heartbeats, got ${JSON.stringify(subscriber.frames())}`);
      beats.forEach((beat, index) => {
        assert.equal(beat.seq, index + 1);
        assert.equal(typeof beat.data.timestamp, "string");
        assert.ok(beat.data.uptimeMs >= 0);
      });
      assert.equal(bystander.frames().length, 0, "non-subscribers receive no events");

      subscriber.buffered = 4 * 1024 * 1024 + 1;
      t.mock.timers.tick(20);
      assert.equal(subscriber.dropped, true);
      assert.match(stderr.join("\n"), /dropped slow consumer/);

      subscriber.buffered = 0;
      t.mock.timers.tick(20);
      t.mock.timers.tick(20);
      assert.equal(beatsOf(subscriber).length, 2, "a dropped connection receives no further events");
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
    await connection.waitForFrame((frame) => frame.id === "s");
    assert.equal(connection.frames().filter((frame) => frame.event).length, 0);
    await server.close();
  });
});
