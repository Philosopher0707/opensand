import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager, isPidAlive } from "../src/state-manager.js";

describe("StateManager", () => {
  let tempStateDir: string;
  let manager: StateManager;

  before(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-state-test-"));
    manager = new StateManager(tempStateDir);
  });

  after(async () => {
    await fs.rm(tempStateDir, { recursive: true, force: true });
  });

  it("writes and reads daemon state", async () => {
    const initialState = {
      pid: process.pid,
      startedAt: Date.now(),
      inflightCount: 0,
      generation: 1,
    };

    await manager.writeDaemonState(initialState);
    const read = await manager.readDaemonState();
    assert.deepEqual(read, initialState);
  });

  it("writes and reads connection configuration", async () => {
    const conn = {
      baseUrl: "https://api.openai.com/v1",
      token: "sk-mock-key",
      headers: { "X-Custom": "value" },
    };

    await manager.writeConnection(conn);
    const read = await manager.readConnection();
    assert.deepEqual(read, conn);
  });

  it("writes and reads supervisor heartbeat", async () => {
    const hb = {
      pid: 12345,
      at: Date.now(),
    };

    await manager.writeSupervisorHeartbeat(hb);
    const read = await manager.readSupervisorHeartbeat();
    assert.deepEqual(read, hb);
  });

  it("updates and reads permission gates", async () => {
    await manager.writePermissionGates({
      computerUseAllowed: true,
      standingAllowlist: ["ls *", "pwd"],
    });

    const gates = await manager.readPermissionGates();
    assert.equal(gates.computerUseAllowed, true);
    assert.equal(gates.deviceToolsAllowed, false);
    assert.deepEqual(gates.standingAllowlist, ["ls *", "pwd"]);
  });

  describe("isPidAlive helper", () => {
    it("reports active process for current PID", () => {
      assert.equal(isPidAlive(process.pid), true);
      assert.equal(manager.isPidAlive(process.pid), true);
    });

    it("rejects non-integer, zero, negative, or invalid numbers", () => {
      assert.equal(isPidAlive(0), false);
      assert.equal(isPidAlive(-1), false);
      assert.equal(isPidAlive(-999), false);
      assert.equal(isPidAlive(12.34), false);
      assert.equal(isPidAlive(NaN as any), false);
      assert.equal(isPidAlive(Infinity as any), false);
      assert.equal(isPidAlive("123" as any), false);
      assert.equal(isPidAlive(undefined as any), false);
      assert.equal(isPidAlive(null as any), false);
    });

    it("reports false for dead/non-existent process PID (ESRCH)", () => {
      // 999999 is extraordinarily unlikely to exist as a valid PID on macOS/Linux
      assert.equal(isPidAlive(999999), false);
    });
  });

  describe("isDaemonRunning liveness probe", () => {
    it("returns running: false, stale: false when no state file exists", async () => {
      const emptyStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-empty-state-"));
      try {
        const emptyManager = new StateManager(emptyStateDir);
        const liveness = await emptyManager.isDaemonRunning();
        assert.deepEqual(liveness, { running: false, stale: false });
      } finally {
        await fs.rm(emptyStateDir, { recursive: true, force: true });
      }
    });

    it("returns running: false, stale: false when state has missing or invalid PID", async () => {
      const invalidStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-invalid-state-"));
      try {
        const invalidMgr = new StateManager(invalidStateDir);
        await invalidMgr.writeDaemonState({ pid: 0, startedAt: Date.now(), inflightCount: 0, generation: 1 });
        const res = await invalidMgr.isDaemonRunning();
        assert.deepEqual(res, { running: false, stale: false });
      } finally {
        await fs.rm(invalidStateDir, { recursive: true, force: true });
      }
    });

    it("returns running: true, stale: false when PID is alive", async () => {
      await manager.writeDaemonState({
        pid: process.pid,
        startedAt: Date.now(),
        inflightCount: 0,
        generation: 3,
      });

      const liveness = await manager.isDaemonRunning();
      assert.equal(liveness.running, true);
      assert.equal(liveness.stale, false);
      assert.equal(liveness.pid, process.pid);
      assert.equal(liveness.generation, 3);
    });

    it("returns running: false, stale: true when state PID is dead", async () => {
      await manager.writeDaemonState({
        pid: 999999,
        startedAt: Date.now() - 10000,
        inflightCount: 0,
        generation: 4,
      });

      const liveness = await manager.isDaemonRunning();
      assert.equal(liveness.running, false);
      assert.equal(liveness.stale, true);
      assert.equal(liveness.pid, 999999);
      assert.equal(liveness.generation, 4);
    });
  });

});
