import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MissionRunnerManager } from "../src/missions/manager.js";
import { ScriptedMissionAgent } from "../src/missions/agent.js";

describe("MissionRunnerManager shutdown", () => {
  it("refuses a start after stopAll() began, so nothing writes into a removed state dir", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-mgr-shutdown-"));
    try {
      const manager = new MissionRunnerManager(base, new ScriptedMissionAgent([{ claim: "done" }]), () => {});
      await manager.stopAll();
      await assert.rejects(
        manager.startMission({
          missionId: "m-late",
          workspaceRoot: base,
          title: "late",
          initialQuery: "q",
          checkCommand: "true",
          budget: { maxRepairs: 0 },
        }),
        /shutting down/,
      );
      assert.equal(manager.activeCount(), 0);
      assert.equal(fs.existsSync(path.join(base, "missions")), false, "a refused start must not create mission state");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
