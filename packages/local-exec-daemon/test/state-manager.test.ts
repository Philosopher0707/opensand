import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";

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
});
