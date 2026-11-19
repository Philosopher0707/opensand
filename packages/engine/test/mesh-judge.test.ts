import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeAttempts, type JudgeAttempt, type MeshDecision } from "../src/mesh/judge.js";
import type { MeshAttemptResultData } from "../src/mesh/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Compiled tests live in packages/engine/dist/test. */
const fixtureDir = path.resolve(here, "..", "..", "test", "fixtures", "mesh");

function readFixture(name: string): JudgeAttempt[] {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8")) as JudgeAttempt[];
}

/** A reviewer stub: records what it was given, returns a scripted raw string or throws. */
function reviewerStub(output: string | Error) {
  const calls: JudgeAttempt[][] = [];
  const stub = (tied: JudgeAttempt[]): string => {
    calls.push(tied);
    if (output instanceof Error) throw output;
    return output;
  };
  return Object.assign(stub, { calls });
}

async function judge(
  attempts: JudgeAttempt[],
  review?: (tied: JudgeAttempt[]) => Promise<string> | string,
  maxDiffLines?: number,
): Promise<MeshDecision> {
  return judgeAttempts(attempts, { review, maxDiffLines });
}

const passing = (n: number, over: Partial<MeshAttemptResultData> = {}): JudgeAttempt => ({
  n,
  result: {
    role: "coder",
    model: `provider-${n}:model`,
    family: "fam",
    outcome: "passed",
    checkExit: 0,
    diffLines: 40,
    costUsd: 0.002,
    wallMs: 60000,
    ...over,
  } satisfies MeshAttemptResultData,
});

describe("mesh judge stage 0 gate", () => {
  it("fixture: every gate rejection keeps its reason and no attempt is eligible", async () => {
    const calls: JudgeAttempt[][] = [];
    const decision = await judge(readFixture("attempts-gate-rejections.json"), (tied) => {
      calls.push(tied);
      return "{}";
    });
    assert.deepEqual(decision.eligible, []);
    assert.deepEqual(decision.rejected, [
      { n: 1, reason: "check-failed" },
      { n: 2, reason: "containment-events" },
      { n: 3, reason: "scope-violations" },
      { n: 4, reason: "diff-too-large" },
      { n: 5, reason: "interrupted" },
    ]);
    assert.equal(decision.winner, null);
    assert.deepEqual(decision.order, []);
    assert.deepEqual(calls, [], "no eligible attempt: the reviewer is never called");
    assert.equal(decision.tieBreak, "deterministic");
  });

  it("fixture: a no-change attempt never wins", async () => {
    const decision = await judge(readFixture("attempts-no-change.json"));
    assert.deepEqual(decision.rejected, [{ n: 1, reason: "no-change" }]);
    assert.equal(decision.winner, null);
  });

  it("fixture: a failed check never wins, even when the reviewer stub prefers it", async () => {
    const attempts = [
      ...readFixture("attempts-failed-check.json"),
      passing(2),
      passing(3, { diffLines: 42 }),
    ];
    // The reviewer tries to smuggle the failed attempt (1) into its order.
    const review = reviewerStub(JSON.stringify({ order: [1, 2, 3], reason: "prefers 1" }));
    const decision = await judge(attempts, review);
    assert.deepEqual(decision.eligible, [2, 3]);
    assert.deepEqual(decision.rejected, [{ n: 1, reason: "check-failed" }]);
    assert.equal(decision.tieBreak, "fallback-deterministic");
    assert.notEqual(decision.winner, 1);
    assert.equal(decision.winner, 2);
  });

  it("a missing check (exit undefined) is not a pass", async () => {
    const decision = await judge([passing(1, { checkExit: undefined })]);
    assert.deepEqual(decision.rejected, [{ n: 1, reason: "check-not-run" }]);
  });

  it("maxDiffLines overrides the 1000 default in both directions", async () => {
    const big = passing(1, { diffLines: 1200 });
    assert.deepEqual((await judge([big])).rejected, [{ n: 1, reason: "diff-too-large" }]);
    assert.deepEqual((await judge([big], undefined, 2000)).eligible, [1]);
  });
});

describe("mesh judge stage 1 rank", () => {
  it("ranks by diffLines asc, then costUsd asc with null last", async () => {
    // The three 100-line attempts sit outside the band of the 39-line winner,
    // so Stage 1's order is the final answer with no model call.
    const attempts = [
      passing(1, { diffLines: 100, costUsd: 0.02 }),
      passing(2, { diffLines: 100, costUsd: 0.01 }),
      passing(3, { diffLines: 100, costUsd: null }),
      passing(4, { diffLines: 39, costUsd: 0.9 }),
    ];
    const decision = await judge(attempts);
    assert.deepEqual(decision.order, [4, 2, 1, 3]);
    assert.equal(decision.winner, 4);
    assert.deepEqual(decision.band, [4]);
    assert.equal(decision.tieBreak, "deterministic");
  });

  it("equal diff and cost break by wallMs asc, then attempt number", async () => {
    const attempts = [
      passing(1, { diffLines: 100, wallMs: 60000 }),
      passing(2, { wallMs: 60000 }),
      passing(3, { diffLines: 100, wallMs: 70000 }),
    ];
    const decision = await judge(attempts);
    assert.deepEqual(decision.band, [2]);
    assert.deepEqual(decision.order, [2, 1, 3]);
    assert.equal(decision.tieBreak, "deterministic");
  });
});

describe("mesh judge stage 2 tie-break", () => {
  it("fixture: a tie inside the band goes to the reviewer, who only sees the tied attempts", async () => {
    const attempts = readFixture("attempts-tie.json");
    const review = reviewerStub(JSON.stringify({ order: [2, 1], reason: "fam-b cleaner" }));
    const decision = await judge(attempts, review);
    assert.deepEqual(decision.band, [1, 2], "attempt 3 (400 lines) is outside the band");
    assert.equal(decision.tieBreak, "reviewer");
    assert.deepEqual(decision.order, [2, 1, 3]);
    assert.equal(decision.winner, 2);
    assert.equal(review.calls.length, 1);
    assert.deepEqual(
      review.calls[0].map((a) => a.n),
      [1, 2],
      "the reviewer gets only the tied attempts",
    );
    assert.ok(review.calls[0].every((a) => typeof a.diff === "string" && a.diff.length > 0));
    assert.ok(review.calls[0].every((a) => typeof a.checkOutput === "string"));
  });

  it("alone in the band wins with no model call", async () => {
    const review = reviewerStub('{"order":[]}');
    const decision = await judge(readFixture("attempts-clear-win.json"), review);
    assert.deepEqual(decision.band, [1]);
    assert.equal(decision.winner, 1);
    assert.equal(decision.tieBreak, "deterministic");
    assert.equal(review.calls.length, 0);
    assert.equal(decision.reviewerRaw, undefined);
  });

  it("invalid reviewer JSON falls back to Stage 1 and records fallback-deterministic", async () => {
    const review = reviewerStub("not json at all");
    const decision = await judge(readFixture("attempts-tie.json"), review);
    assert.equal(decision.tieBreak, "fallback-deterministic");
    assert.deepEqual(decision.order, [1, 2, 3], "Stage 1's order stands");
    assert.equal(decision.winner, 1);
    assert.equal(decision.reviewerRaw, "not json at all");
  });

  it("a reviewer call error or timeout falls back like any invalid output", async () => {
    const review = reviewerStub(new Error("reviewer timed out"));
    const decision = await judge(readFixture("attempts-tie.json"), review);
    assert.equal(decision.tieBreak, "fallback-deterministic");
    assert.deepEqual(decision.order, [1, 2, 3]);
    assert.equal(decision.winner, 1);
    assert.equal(decision.reviewerRaw, "");
  });

  it("a non-permutation reviewer order (duplicate or missing id) falls back", async () => {
    const dup = await judge(readFixture("attempts-tie.json"), reviewerStub('{"order":[1,1]}'));
    assert.equal(dup.tieBreak, "fallback-deterministic");
    const missing = await judge(readFixture("attempts-tie.json"), reviewerStub('{"order":[1]}'));
    assert.equal(missing.tieBreak, "fallback-deterministic");
  });

  it("a reviewer that quotes attempt ids still validates", async () => {
    const review = reviewerStub(JSON.stringify({ order: ["2", "1"], reason: "ok" }));
    const decision = await judge(readFixture("attempts-tie.json"), review);
    assert.equal(decision.tieBreak, "reviewer");
    assert.deepEqual(decision.order, [2, 1, 3]);
  });
});

describe("mesh decision record", () => {
  it("inputsHash covers the attempts and the gate settings, and is deterministic", async () => {
    const attempts = readFixture("attempts-clear-win.json");
    const a = await judge(attempts);
    const b = await judge(attempts);
    assert.equal(a.inputsHash, b.inputsHash);
    const changed = await judge([...attempts, passing(3)]);
    const tuned = await judge(attempts, undefined, 500);
    assert.notEqual(a.inputsHash, changed.inputsHash);
    assert.notEqual(a.inputsHash, tuned.inputsHash);
  });

  it("the reviewer's order never leaves the band, even with a valid permutation", async () => {
    // The reviewer ranks the two tied attempts; attempt 3 stays behind both.
    const review = reviewerStub(JSON.stringify({ order: [2, 1], reason: "ok" }));
    const decision = await judge(readFixture("attempts-tie.json"), review);
    assert.deepEqual(decision.order, [2, 1, 3]);
  });
});
