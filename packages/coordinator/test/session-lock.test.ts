import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { SessionLockManager, SessionLockedError } from "../src/session-lock.js";

describe("SessionLockManager", () => {
  let tempDir: string;
  let manager: SessionLockManager;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-lock-test-"));
    manager = new SessionLockManager(tempDir);
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("acquires and cleanly releases session locks", async () => {
    const sessionId = "sess_clean_lock";
    const inspectBefore = await manager.inspect(sessionId);
    assert.equal(inspectBefore.locked, false);
    assert.equal(inspectBefore.stale, false);

    const handle = await manager.acquire(sessionId);
    assert.equal(handle.sessionId, sessionId);
    assert.equal(handle.pid, process.pid);

    const inspectLocked = await manager.inspect(sessionId);
    assert.equal(inspectLocked.locked, true);
    assert.equal(inspectLocked.pid, process.pid);
    assert.equal(inspectLocked.stale, false);

    await handle.release();

    const inspectAfter = await manager.inspect(sessionId);
    assert.equal(inspectAfter.locked, false);
    assert.equal(inspectAfter.stale, false);
  });

  it("prevents active concurrent lock acquisition with SessionLockedError", async () => {
    const sessionId = "sess_conflict";
    const handle = await manager.acquire(sessionId);

    await assert.rejects(
      async () => {
        await manager.acquire(sessionId);
      },
      (err: any) => {
        assert.ok(err instanceof SessionLockedError);
        assert.equal(err.sessionId, sessionId);
        assert.equal(err.pid, process.pid);
        return true;
      }
    );

    await handle.release();
  });

  it("reclaims stale lock when holding PID is dead (ESRCH)", async () => {
    const sessionId = "sess_stale_pid";
    const sessionDir = path.join(tempDir, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    // Spawn a quick short-lived process to obtain a definitively exited PID
    const proc = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = proc.pid;
    assert.ok(deadPid, "Spawned process should have a PID");

    // Double-check PID is dead
    let isDead = false;
    try {
      process.kill(deadPid, 0);
    } catch (err: any) {
      if (err.code === "ESRCH") isDead = true;
    }
    assert.ok(isDead, `PID ${deadPid} must be dead for this test`);

    const staleLock = {
      pid: deadPid,
      startedAt: Date.now() - 3600000,
      hostname: "crashed-host",
    };
    await fs.writeFile(path.join(sessionDir, "session.lock"), JSON.stringify(staleLock));

    const inspection = await manager.inspect(sessionId);
    assert.equal(inspection.locked, true);
    assert.equal(inspection.pid, deadPid);
    assert.equal(inspection.stale, true);

    // Acquire should automatically detect ESRCH and reclaim the stale lock
    const handle = await manager.acquire(sessionId);
    assert.equal(handle.pid, process.pid);

    const inspectAfter = await manager.inspect(sessionId);
    assert.equal(inspectAfter.locked, true);
    assert.equal(inspectAfter.pid, process.pid);
    assert.equal(inspectAfter.stale, false);

    await handle.release();
  });

  it("overrides active lock when force: true option is supplied", async () => {
    const sessionId = "sess_force_override";
    const handle1 = await manager.acquire(sessionId);

    // Without force, acquire fails
    await assert.rejects(async () => {
      await manager.acquire(sessionId);
    }, SessionLockedError);

    // With force: true, acquire succeeds and overrides
    const handle2 = await manager.acquire(sessionId, { force: true });
    assert.equal(handle2.sessionId, sessionId);
    assert.equal(handle2.pid, process.pid);

    await handle2.release();
    const finalInspect = await manager.inspect(sessionId);
    assert.equal(finalInspect.locked, false);
  });
});
