import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { LocalExecDaemon } from "../src/daemon.js";

describe("LocalExecDaemon", () => {
  let tempDir: string;
  let daemon: LocalExecDaemon;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-daemon-test-"));
    daemon = new LocalExecDaemon({
      stateDir: tempDir,
      heartbeatIntervalMs: 100,
    });
  });

  after(async () => {
    await daemon.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("starts, pulses heartbeats, and stops cleanly", async () => {
    assert.equal(daemon.running, false);
    await daemon.start();
    assert.equal(daemon.running, true);

    const state = await daemon.state.readDaemonState();
    assert.ok(state);
    assert.equal(state?.pid, process.pid);
    assert.equal(state?.generation, 1);

    const hb = await daemon.state.readSupervisorHeartbeat();
    assert.ok(hb);
    assert.equal(hb?.pid, process.pid);

    await daemon.stop();
    assert.equal(daemon.running, false);
  });

  it("manages gates and executes tools through the daemon", async () => {
    await daemon.updateGates({ computerUseAllowed: true });
    const gates = await daemon.getGates();
    assert.equal(gates.computerUseAllowed, true);

    const res = await daemon.executeTool("exec_command", {
      command: "echo 'daemon tool execution'",
    });

    assert.equal(res.status, "ok");
    assert.equal(res.output.stdout.trim(), "daemon tool execution");
  });

  it("ensureStarted() starts stopped daemon and self-heals corrupted state", async () => {
    const healDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-daemon-heal-"));
    try {
      const healDaemon = new LocalExecDaemon({ stateDir: healDir, heartbeatIntervalMs: 50 });
      assert.equal(healDaemon.running, false);

      // 1. Calling ensureStarted on stopped daemon starts it
      await healDaemon.ensureStarted();
      assert.equal(healDaemon.running, true);
      const state1 = await healDaemon.state.readDaemonState();
      assert.equal(state1?.pid, process.pid);

      // 2. Calling ensureStarted on already running daemon keeps it running
      await healDaemon.ensureStarted();
      assert.equal(healDaemon.running, true);

      // 3. Simulating state deletion while daemon claims running causes self-healing restart
      await fs.rm(path.join(healDir, "local-exec-daemon.json"), { force: true });
      await healDaemon.ensureStarted();
      assert.equal(healDaemon.running, true);
      const state2 = await healDaemon.state.readDaemonState();
      assert.equal(state2?.pid, process.pid);
      assert.ok((state2?.generation ?? 0) >= (state1?.generation ?? 0));

      await healDaemon.stop();
      assert.equal(healDaemon.running, false);
    } finally {
      await fs.rm(healDir, { recursive: true, force: true });
    }
  });

});
