import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { foldMeshStats, statsKey, wilsonLowerBound } from "../src/mesh/stats.js";
import { selectStartRung } from "../src/mesh/routing.js";
import { parseRoutesConfig } from "../src/mesh/routes-schema.js";
import type { AttemptOutcome, MeshAttemptResultData, MeshLogRecord } from "../src/mesh/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Compiled tests live in packages/engine/dist/test. */
const fixtureDir = path.resolve(here, "..", "..", "test", "fixtures", "mesh");

function readJsonl(name: string): MeshLogRecord[] {
  return fs
    .readFileSync(path.join(fixtureDir, name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as MeshLogRecord);
}

const LADDER = ["provider-a:model-2", "provider-a:model-1"];

function rec(
  model: string,
  outcome: AttemptOutcome,
  overrides: Partial<{ costUsd: number | null; rung: number }> = {},
): MeshLogRecord {
  return {
    seq: 1,
    kind: "mesh.attempt.result",
    attempt: 1,
    node: "act",
    data: {
      role: "coder",
      model,
      outcome,
      costUsd: 0.002,
      ...overrides,
    } satisfies Partial<MeshAttemptResultData> as MeshAttemptResultData,
  };
}

describe("mesh stats fold", () => {
  it("stats-a: model 1 sits at 9 passes and 1 failure, model 2 at 2 and 8", () => {
    const stats = foldMeshStats(readJsonl("stats-a.jsonl"));
    const m1 = stats.get(statsKey("coder", "provider-a:model-1"))!;
    const m2 = stats.get(statsKey("coder", "provider-a:model-2"))!;
    assert.equal(m1.counted, 10);
    assert.equal(m1.passed, 9);
    assert.equal(m2.counted, 10);
    assert.equal(m2.passed, 2);
    assert.ok(Math.abs(m1.rateWilsonLow - 0.596) < 0.0005, `m1 rateWilsonLow ${m1.rateWilsonLow}`);
    assert.ok(Math.abs(m2.rateWilsonLow - 0.057) < 0.0005, `m2 rateWilsonLow ${m2.rateWilsonLow}`);
    assert.equal(m1.costMedianUsd, 0.002);
    assert.equal(m1.timeouts, 0);
  });

  it("stats-a + stats-b: model 1 falls to 9/20, model 2 rises to 20/28", () => {
    const records = [...readJsonl("stats-a.jsonl"), ...readJsonl("stats-b.jsonl")];
    const stats = foldMeshStats(records);
    const m1 = stats.get(statsKey("coder", "provider-a:model-1"))!;
    const m2 = stats.get(statsKey("coder", "provider-a:model-2"))!;
    assert.equal(m1.counted, 20);
    assert.equal(m1.passed, 9);
    assert.ok(Math.abs(m1.rateWilsonLow - 0.258) < 0.0005, `m1 rateWilsonLow ${m1.rateWilsonLow}`);
    assert.equal(m2.counted, 28);
    assert.equal(m2.passed, 20);
    assert.ok(Math.abs(m2.rateWilsonLow - 0.529) < 0.0005, `m2 rateWilsonLow ${m2.rateWilsonLow}`);
  });

  it("a model with 1 sample never qualifies", () => {
    const stats = foldMeshStats([rec("solo:model", "passed")]);
    const start = selectStartRung("coder", ["solo:model"], stats, 0);
    assert.deepEqual(start, { rung: 0, model: "solo:model", reason: "no-qualifying-record" });
  });

  it("only counted outcomes move the rate: one infra_error leaves 9/10 unchanged", () => {
    const base = Array.from({ length: 10 }, (_, i) =>
      rec("solo:model", i === 0 ? "check_failed" : "passed"),
    );
    const withInfra = [...base, rec("solo:model", "infra_error", { costUsd: 0 })];
    const before = foldMeshStats(base).get(statsKey("coder", "solo:model"))!;
    const after = foldMeshStats(withInfra).get(statsKey("coder", "solo:model"))!;
    assert.equal(after.counted, before.counted);
    assert.equal(after.passed, before.passed);
    assert.equal(after.rateWilsonLow, before.rateWilsonLow);
    // 9/10 keeps qualifying (Wilson lower bound 0.596 >= 0.5).
    const start = selectStartRung("coder", ["solo:model"], foldMeshStats(withInfra), 0);
    assert.equal(start.model, "solo:model");
    assert.equal(start.reason, "qualifying-record");
  });

  it("boundary: one check_failed (9/11) still qualifies; two (9/12) move the start", () => {
    const base = Array.from({ length: 10 }, (_, i) =>
      rec("solo:model", i === 0 ? "check_failed" : "passed"),
    );
    // 9/11 lower bound is 0.523, still >= 0.5: one real failure does not move it.
    const one = [...base, rec("solo:model", "check_failed")];
    assert.equal(wilsonLowerBound(9, 11) >= 0.5, true);
    const startOne = selectStartRung("coder", ["solo:model"], foldMeshStats(one), 0);
    assert.equal(startOne.reason, "qualifying-record");
    // 9/12 lower bound is 0.468, below 0.5: two real failures move the start.
    const two = [...one, rec("solo:model", "check_failed")];
    assert.equal(wilsonLowerBound(9, 12) < 0.5, true);
    const startTwo = selectStartRung("coder", ["solo:model"], foldMeshStats(two), 0);
    assert.equal(startTwo.reason, "no-qualifying-record");
  });
});

describe("mesh start-rung routing", () => {
  it("stats-a: the start is model 1 (model 2 never qualifies)", () => {
    const stats = foldMeshStats(readJsonl("stats-a.jsonl"));
    const start = selectStartRung("coder", LADDER, stats, 0);
    assert.deepEqual(start, { rung: 1, model: "provider-a:model-1", reason: "qualifying-record" });
  });

  it("stats-a + stats-b: the start moves to model 2", () => {
    const records = [...readJsonl("stats-a.jsonl"), ...readJsonl("stats-b.jsonl")];
    const start = selectStartRung("coder", LADDER, foldMeshStats(records), 0);
    assert.deepEqual(start, { rung: 0, model: "provider-a:model-2", reason: "qualifying-record" });
  });

  it("no qualifying record falls back to rung 0", () => {
    const start = selectStartRung("coder", LADDER, new Map(), 0);
    assert.deepEqual(start, { rung: 0, model: LADDER[0], reason: "no-qualifying-record" });
  });

  it("a rung with 3 timeouts and no success after them is skipped", () => {
    const outcomes: AttemptOutcome[] = [
      "passed",
      "timeout",
      "timeout",
      "timeout",
      "check_failed",
      "check_failed",
      "check_failed",
      "check_failed",
      "check_failed",
      "check_failed",
    ];
    const records = outcomes.map((outcome) => rec("solo:model", outcome, { costUsd: 0 }));
    // Counted 1/7 never qualifies, so the only way rung 0 is used is via the fallback.
    const start = selectStartRung("coder", ["solo:model"], foldMeshStats(records), 0);
    assert.equal(start.reason, "timeout-window");
  });

  it("a success after the third timeout lifts the skip", () => {
    const outcomes: AttemptOutcome[] = [
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "timeout",
      "timeout",
      "timeout",
      "passed",
      "passed",
    ];
    const records = outcomes.map((outcome) => rec("solo:model", outcome, { costUsd: 0 }));
    // 7/7 counted qualifies; the timeout window must not bench it.
    const start = selectStartRung("coder", ["solo:model"], foldMeshStats(records), 0);
    assert.deepEqual(start, { rung: 0, model: "solo:model", reason: "qualifying-record" });
  });

  it("a benched rung is skipped in favour of a later qualifying one", () => {
    const benched = (["passed", "timeout", "timeout", "timeout", "check_failed", "check_failed", "check_failed", "check_failed", "check_failed", "check_failed"] as AttemptOutcome[]).map(
      (outcome) => rec("benched:model", outcome, { costUsd: 0 }),
    );
    const healthy = Array.from({ length: 6 }, () => rec("healthy:model", "passed"));
    const stats = foldMeshStats([...benched, ...healthy]);
    const start = selectStartRung("coder", ["benched:model", "healthy:model"], stats, 0);
    assert.deepEqual(start, { rung: 1, model: "healthy:model", reason: "qualifying-record" });
  });
});

describe("mesh routes.json schema", () => {
  it("parses a valid config and fills threshold defaults", () => {
    const config = parseRoutesConfig({
      version: 1,
      roles: { coder: { ladder: ["ollama:qwen3:8b"] } },
    });
    assert.deepEqual(config.roles.coder, {
      ladder: ["ollama:qwen3:8b"],
      minSamples: 5,
      minPassRate: 0.5,
    });
  });

  it("keeps explicit thresholds", () => {
    const config = parseRoutesConfig({
      version: 1,
      roles: { reviewer: { ladder: ["openrouter:r"], minSamples: 3, minPassRate: 0.7 } },
    });
    assert.deepEqual(config.roles.reviewer, {
      ladder: ["openrouter:r"],
      minSamples: 3,
      minPassRate: 0.7,
    });
  });

  const bad: Array<[string, unknown]> = [
    ["version", { version: 2, roles: { coder: { ladder: ["a:b"] } } }],
    ["roles", { version: 1, roles: {} }],
    ["roles", { version: 1, roles: [] }],
    ["ladder", { version: 1, roles: { coder: { ladder: [] } } }],
    ["provider:model", { version: 1, roles: { coder: { ladder: ["qwen3"] } } }],
    ["minSamples", { version: 1, roles: { coder: { ladder: ["a:b"], minSamples: 0 } } }],
    ["minPassRate", { version: 1, roles: { coder: { ladder: ["a:b"], minPassRate: 0 } } }],
    ["minPassRate", { version: 1, roles: { coder: { ladder: ["a:b"], minPassRate: 1.5 } } }],
    ["top level", null],
  ];

  for (const [expected, input] of bad) {
    it(`refuses a config with a bad ${expected}`, () => {
      assert.throws(() => parseRoutesConfig(input), (err: Error) => {
        return err.message.includes("mesh/routes.json") && err.message.includes(expected);
      });
    });
  }
});
