import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { WorkspaceSentinel, SentinelDiagnosticEvent } from "../src/workspace-sentinel.js";

describe("WorkspaceSentinel", () => {
  let tempDir: string;
  let sentinel: WorkspaceSentinel;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-sentinel-test-"));
    sentinel = new WorkspaceSentinel();
  });

  afterEach(async () => {
    sentinel.stopAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("registers, lists, and stops workspace watchers", async () => {
    const watcher = await sentinel.startWatcher({
      targetDir: tempDir,
      debounceMs: 100,
    });

    assert.ok(watcher.id.startsWith("watcher_"));
    assert.strictEqual(watcher.targetDir, path.resolve(tempDir));

    const activeList = sentinel.getWatchers();
    assert.strictEqual(activeList.length, 1);
    assert.strictEqual(activeList[0].id, watcher.id);

    const stopped = sentinel.stopWatcher(watcher.id);
    assert.strictEqual(stopped, true);

    const listAfter = sentinel.getWatchers();
    assert.strictEqual(listAfter.length, 0);
  });

  it("runs diagnostic and records clean status when check passes", async () => {
    const watcher = await sentinel.startWatcher({
      targetDir: tempDir,
      checkCommand: "echo ok",
      debounceMs: 50,
    });

    const event = await sentinel.runDiagnostic(watcher, "sample.ts");
    assert.strictEqual(event.status, "clean");
    assert.ok(event.output.includes("ok"));

    const logs = sentinel.getLogs(watcher.id);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].id, event.id);
  });

  it("detects command failures and triggers self-healing callback", async () => {
    let healingInvoked = false;

    sentinel.setHealer(async (event: SentinelDiagnosticEvent) => {
      healingInvoked = true;
      assert.strictEqual(event.status, "healing");
      return {
        healed: true,
        proposal: "Applied syntax correction to fix missing semicolon.",
      };
    });

    const watcher = await sentinel.startWatcher({
      targetDir: tempDir,
      checkCommand: "node -e 'process.exit(1)'", // Fails on purpose
      autoHeal: true,
      debounceMs: 50,
    });

    const event = await sentinel.runDiagnostic(watcher, "broken.ts");
    assert.strictEqual(healingInvoked, true);
    assert.strictEqual(event.status, "healed");
    assert.ok(event.healingProposal?.includes("Applied syntax correction"));
  });
});
