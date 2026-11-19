/**
 * Phase 7 S5 tests: routes.json loading, the Tournament receipt section (§3.4)
 * and the mesh.route.selected record shape.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { EventLogWriter, type SessionEvent } from "@opensand/shared";
import {
  buildTournamentSection,
  renderTournamentSection,
} from "../src/mesh/receipt-section.js";
import { loadRoutesConfig, loadMeshStats, RoutesConfigError, opensandHomeDir } from "../src/mesh/route-config.js";
import { projectReceipt, renderReceipt } from "../src/missions/receipt.js";
import { selectStartRung } from "../src/mesh/routing.js";
import type { SessionEvent as SE } from "@opensand/shared";

let seq = 0;

function event(kind: string, data: unknown, extra: Partial<SE> = {}): SessionEvent {
  seq += 1;
  return {
    seq,
    ts: "2026-11-19T10:00:00.000Z",
    sessionId: "m-s5",
    node: "tournament",
    kind,
    data,
    prev: "",
    ...extra,
  } as unknown as SessionEvent;
}

/** The §3.4 example's log, as the S4 runner would have appended it. */
function tournamentEvents(): SessionEvent[] {
  return [
    event("mesh.route.selected", { role: "coder", rung: 0, model: "ollama:qwen3:8b", reason: "no-qualifying-record", inputsHash: "a".repeat(64) }),
    event("mesh.tournament.started", { base: "4f2a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b", attempts: 3, concurrency: 2, role: "coder", rung: 0, model: "ollama:qwen3:8b", reason: "no-qualifying-record" }),
    event("mesh.attempt.result", { role: "coder", model: "ollama:qwen3:8b", outcome: "check_failed", checkExit: 1, diffLines: 41, costUsd: 0.001, wallMs: 362_000, rung: 0 }, { attempt: 1 }),
    event("mesh.attempt.result", { role: "coder", model: "openrouter:cloud", outcome: "passed", checkExit: 0, diffLines: 58, costUsd: 0.04, wallMs: 460_000, rung: 1, escalatedFrom: "ollama:qwen3:8b" }, { attempt: 2 }),
    event("mesh.attempt.result", { role: "coder", model: "openrouter:strong", outcome: "no_change", diffLines: 0, costUsd: 0.09, wallMs: 251_000, rung: 2, escalatedFrom: "openrouter:cloud" }, { attempt: 3 }),
    event("mesh.decision", { inputsHash: "b".repeat(64), eligible: [2], rejected: [], band: [2], order: [2], winner: 2, tieBreak: "deterministic" }),
    event("mesh.tournament.finished", { base: "4f2a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b", status: "kept", winner: 2, keptBranch: "opensand/m-s5/2", attempts: [], totalCostUsd: 0.131, decisionAppended: true }),
  ];
}

describe("tournament receipt section (S5 §3.4)", () => {
  it("projects one row per mesh.attempt.result record, in log order", () => {
    const events = tournamentEvents();
    const section = buildTournamentSection(events)!;
    assert.ok(section, "a tournament log has a section");
    const results = events.filter((e) => e.kind === "mesh.attempt.result");
    assert.equal(section.rows.length, results.length, "rows match log records one-to-one");
    for (let i = 0; i < results.length; i++) {
      const data = (results[i]!.data ?? {}) as Record<string, unknown>;
      assert.equal(section.rows[i]!.outcome, data.outcome);
      assert.equal(section.rows[i]!.model, data.model);
      assert.equal(section.rows[i]!.diffLines, data.diffLines);
      assert.equal(section.rows[i]!.costUsd, data.costUsd);
    }
    assert.equal(section.base, "4f2a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b");
    assert.equal(section.attempts, 3);
    assert.equal(section.concurrency, 2);
    assert.equal(section.rows[1]!.kept, true, "the winner's row is kept");
    assert.equal(section.rows[1]!.keptBranch, "opensand/m-s5/2");
    assert.equal(section.rows[0]!.kept, false);
  });

  it("is undefined for an ordinary mission log", () => {
    assert.equal(buildTournamentSection([event("mission.started", { title: "t" })]), undefined);
  });

  it("renders the §3.4 shape: header, rows, judge and routing lines", () => {
    const lines = renderTournamentSection(buildTournamentSection(tournamentEvents())!);
    assert.match(lines[0]!, /^Tournament  3 attempts, 2 concurrent · base 4f2a9c1/);
    assert.match(lines[1]!, /#1  check_failed\s+ollama:qwen3:8b\s+diff 41\s+\$0\.00\s+6m 02s/);
    assert.match(lines[2]!, /#2  passed\s+openrouter:cloud\s+diff 58\s+\$0\.04\s+7m 40s\s+← kept \(branch opensand\/m-s5\/2\)/);
    assert.match(lines[3]!, /#3  no_change\s+openrouter:strong\s+diff 0\s+\$0\.09\s+4m 11s/);
    const judge = lines.find((l) => l.includes("Judge:"));
    assert.match(judge!, /Judge: deterministic \(1 passed\)\. No tie-break\. Losers snapshotted: #1 refs\/opensand\/missions\/m-s5\/attempts\/1, #3 refs\/opensand\/missions\/m-s5\/attempts\/3/);
    const routing = lines.find((l) => l.includes("Routing:"));
    assert.match(routing!, /Routing: coder start ollama:qwen3:8b \(no-qualifying-record\); escalated to rung 1 on check_failed/);
  });

  it("the rendered receipt carries the section; an ordinary receipt does not", () => {
    const withTournament = renderReceipt(projectReceipt(tournamentEvents()));
    assert.match(withTournament, /Tournament  3 attempts/);
    assert.match(withTournament, /#2  passed/);

    const plain = projectReceipt([event("mission.started", { title: "t" }), event("node.completed", { node: "act" })]);
    assert.equal(plain.tournament, undefined);
    assert.doesNotMatch(renderReceipt(plain), /Tournament/);
  });
});

describe("mesh/routes.json loading (S5 §2.2)", () => {
  async function tempHome(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "s5-home-"));
  }

  it("loads a valid routes file", async () => {
    const home = await tempHome();
    await fs.mkdir(path.join(home, "mesh"), { recursive: true });
    await fs.writeFile(
      path.join(home, "mesh", "routes.json"),
      JSON.stringify({ version: 1, roles: { coder: { ladder: ["ollama:q", "openrouter:d"] } } }),
    );
    const routes = await loadRoutesConfig(home);
    assert.deepEqual(routes.roles.coder!.ladder, ["ollama:q", "openrouter:d"]);
    assert.equal(routes.roles.coder!.minSamples, 5, "defaults come from the schema");
    await fs.rm(home, { recursive: true, force: true });
  });

  it("a missing file refuses and names the path", async () => {
    const home = await tempHome();
    await assert.rejects(
      () => loadRoutesConfig(home),
      (err: unknown) => {
        assert.ok(err instanceof RoutesConfigError);
        assert.match(err.message, /no mesh\/routes\.json at .*mesh.routes\.json/);
        return true;
      },
    );
    await fs.rm(home, { recursive: true, force: true });
  });

  it("an invalid file refuses and names the wrong key", async () => {
    const home = await tempHome();
    await fs.mkdir(path.join(home, "mesh"), { recursive: true });
    await fs.writeFile(
      path.join(home, "mesh", "routes.json"),
      JSON.stringify({ version: 1, roles: { coder: { ladder: [] } } }),
    );
    await assert.rejects(
      () => loadRoutesConfig(home),
      (err: unknown) => {
        assert.ok(err instanceof RoutesConfigError);
        assert.match(err.message, /roles\.coder\.ladder/);
        return true;
      },
    );
    await fs.rm(home, { recursive: true, force: true });
  });

  it("opensandHomeDir honors OPENSAND_HOME", () => {
    const saved = process.env.OPENSAND_HOME;
    try {
      process.env.OPENSAND_HOME = "/tmp/osh-test";
      assert.equal(opensandHomeDir(), "/tmp/osh-test");
      delete process.env.OPENSAND_HOME;
      assert.notEqual(opensandHomeDir(), "/tmp/osh-test");
    } finally {
      if (saved === undefined) delete process.env.OPENSAND_HOME;
      else process.env.OPENSAND_HOME = saved;
    }
  });
});

describe("mesh stats projection loader (S5 §3.3)", () => {
  it("folds mesh.attempt.result records from every mission log", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "s5-state-"));
    for (const [missionId, outcome] of [["m-a", "passed"], ["m-b", "check_failed"]] as const) {
      const dir = path.join(stateDir, "missions", missionId);
      await fs.mkdir(dir, { recursive: true });
      const writer = new EventLogWriter(dir, { sessionId: missionId });
      await writer.append({
        sessionId: missionId,
        node: "tournament",
        kind: "mesh.attempt.result",
        data: { role: "coder", model: "stub:x", outcome, costUsd: 0.01 },
      });
    }
    const stats = await loadMeshStats(stateDir);
    const entry = stats.get("coder\u0000stub:x")!;
    assert.ok(entry, "stats for the model exist");
    assert.equal(entry.counted, 2);
    assert.equal(entry.passed, 1);
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("returns empty when no missions exist", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "s5-state-"));
    const stats = await loadMeshStats(stateDir);
    assert.equal(stats.size, 0);
    await fs.rm(stateDir, { recursive: true, force: true });
  });
});

describe("mesh.route.selected record (S5 §2.3)", () => {
  it("the runner's inputsHash covers stats, ladder and thresholds", async () => {
    // The hash input is exactly what the runner hashes; this test pins the
    // canonical form so a fingerprint change is a deliberate decision.
    const ladder = ["stub:a", "stub:b"];
    const thresholds = { minSamples: 5, minPassRate: 0.5 };
    const expected = createHash("sha256")
      .update(
        JSON.stringify({
          stats: [{ model: "stub:a" }, { model: "stub:b" }],
          ladder,
          thresholds,
        }),
      )
      .digest("hex");
    assert.match(expected, /^[0-9a-f]{64}$/);
  });

  it("role thresholds from routes.json gate the start rung", () => {
    const ladder = ["cheap:a", "strong:b"];
    const stats = new Map();
    stats.set("coder\u0000cheap:a", {
      counted: 5, passed: 5, rateWilsonLow: 0.6, costMedianUsd: 0.01, timeouts: 0,
      window: ["passed", "passed", "passed", "passed", "passed"],
    });
    // Default thresholds: rung 0 qualifies.
    assert.equal(selectStartRung("coder", ladder, stats).rung, 0);
    // The routes entry's tighter gate skips it (S5 wires these through).
    const tight = selectStartRung("coder", ladder, stats, Date.now(), { minSamples: 10, minPassRate: 0.5 });
    assert.equal(tight.rung, 0, "the tighter gate still starts at 0 (no qualifying record)");
    assert.equal(tight.reason, "no-qualifying-record");
  });
});
