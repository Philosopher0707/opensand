import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startIdleReaper } from "../src/engine-idle.js";

describe("engine idle reaper", () => {
  it("closes only idle sessions without pending turns and stops on request", async () => {
    const previousIdle = process.env.OPENSAND_ENGINE_IDLE_MS;
    const previousTick = process.env.OPENSAND_ENGINE_REAP_TICK_MS;
    process.env.OPENSAND_ENGINE_IDLE_MS = "1000";
    process.env.OPENSAND_ENGINE_REAP_TICK_MS = "20";
    const now = Date.now();
    const sessions = new Map([
      ["idle", { lastUsedAt: now - 5000 }],
      ["fresh", { lastUsedAt: now }],
      ["busy", { lastUsedAt: now - 5000, pendingTurn: {} }],
    ]);
    const closed: string[] = [];
    const stop = startIdleReaper(sessions, (id) => {
      closed.push(id);
      sessions.delete(id);
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.deepStrictEqual(closed, ["idle"]);
      stop();
      closed.length = 0;
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.deepStrictEqual(closed, [], "stopped reaper must not fire again");
    } finally {
      stop();
      if (previousIdle === undefined) delete process.env.OPENSAND_ENGINE_IDLE_MS;
      else process.env.OPENSAND_ENGINE_IDLE_MS = previousIdle;
      if (previousTick === undefined) delete process.env.OPENSAND_ENGINE_REAP_TICK_MS;
      else process.env.OPENSAND_ENGINE_REAP_TICK_MS = previousTick;
    }
  });
});
