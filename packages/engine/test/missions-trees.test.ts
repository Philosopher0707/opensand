import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { EventLogReader, type SessionEvent } from "@opensand/shared";
import { EngineProcess, removeDir, tempDir, trustFolder } from "./helpers.js";
import { projectMission } from "../src/missions/receipt.js";

function git(args: string[], cwd: string): string {
  // A git hook exports GIT_DIR and GIT_INDEX_FILE; without this the test would write into the hooked repo.
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function makeWorkspace(root: string): string {
  const ws = path.join(root, "workspace");
  fs.mkdirSync(ws, { recursive: true });
  git(["init", "-q"], ws);
  git(["config", "user.email", "t@example.com"], ws);
  git(["config", "user.name", "T"], ws);
  fs.writeFileSync(path.join(ws, "README.md"), "# demo\nline two\n", "utf8");
  git(["add", "-A"], ws);
  git(["commit", "-q", "--no-gpg-sign", "-m", "initial"], ws);
  return ws;
}

async function waitEnd(engine: EngineProcess, missionId: string): Promise<any> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const r = await engine.request(`p-${Date.now()}`, "mission.Missions.get", { missionId });
    if (r.result && ["verified", "failed", "stopped"].includes(r.result.status)) return r.result;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("mission did not finish");
}

/** Hooks export GIT_*; drop them for the engine child and the test's own git calls, restore after. */
const HOOK_VARS = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX"] as const;
const saved: Record<string, string | undefined> = {};
before(() => { for (const k of HOOK_VARS) { saved[k] = process.env[k]; delete process.env[k]; } });
after(() => { for (const k of HOOK_VARS) { if (saved[k] !== undefined) process.env[k] = saved[k]; } });

describe("mission terminal events record the git trees", () => {
  it("records baseTree and finalTree, pins them under refs/opensand, and they survive gc", async () => {
    const dir = tempDir("trees");
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-trees-"));
    const ws = makeWorkspace(wsRoot);
    const agentFile = path.join(dir, "agent.json");
    fs.writeFileSync(agentFile, JSON.stringify([{
      claim: "edited README",
      edits: [{ path: "README.md", replaceLine: { line: 2, text: "line two edited" } }],
      review: { accept: true, note: "ok" },
    }]));
    trustFolder(dir, ws);
    const engine = new EngineProcess(dir, ["--scripted-agent", agentFile]);
    try {
      const start = await engine.request("r1", "mission.Missions.start", {
        workspaceRoot: ws, title: "t", initialQuery: "edit", checkCommand: "true",
      });
      const id = start.result.missionId;
      assert.equal((await waitEnd(engine, id)).status, "verified");

      const events = await new EventLogReader(path.join(dir, "missions", id)).readAll();
      const end = events.find((e) => e.kind === "mission.verified")!;
      assert.match(end.data.baseTree, /^[0-9a-f]{40,64}$/);
      assert.match(end.data.finalTree, /^[0-9a-f]{40,64}$/);
      assert.notEqual(end.data.baseTree, end.data.finalTree);

      assert.equal(git(["rev-parse", `refs/opensand/missions/${id}/base`], ws).trim(), end.data.baseTree);
      assert.equal(git(["rev-parse", `refs/opensand/missions/${id}/final`], ws).trim(), end.data.finalTree);

      git(["gc", "--prune=now", "-q"], ws);
      const diff = git(["diff", "--no-color", end.data.baseTree, end.data.finalTree, "--", "README.md"], ws);
      assert.match(diff, /\+line two edited/, "the diff is still viewable after gc");
    } finally {
      await engine.kill();
      removeDir(dir);
      removeDir(wsRoot);
    }
  });
});

describe("old-shape logs", () => {
  it("a terminal record without tree ids still projects as before", () => {
    const mk = (seq: number, kind: string, data: any): SessionEvent => ({ seq, ts: `2026-11-14T09:00:0${seq}.000Z`, kind, data } as any);
    const events = [
      mk(1, "mission.started", { missionId: "old", title: "old" }),
      mk(2, "node.completed", { node: "act", claim: "did it" }),
      mk(3, "check.completed", { passed: true, exitCode: 0 }),
      mk(4, "review.completed", { accept: true }),
      mk(5, "mission.verified", { missionId: "old", changes: [{ file: "a.txt", ranges: [[1, 2]] }] }),
    ];
    const p = projectMission(events);
    assert.equal(p.status, "verified");
    assert.equal(p.receipt?.status, "VERIFIED");
    assert.deepEqual(p.receipt?.changed, [{ file: "a.txt", ranges: [[1, 2]] }]);
  });
});
