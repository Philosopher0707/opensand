import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@opensand/shared";
import { projectReceipt } from "../src/missions/receipt.js";
import { changedLines } from "../src/missions/workspace-diff.js";

let seq = 0;
function event(kind: string, data: Record<string, unknown>): SessionEvent {
  seq += 1;
  return {
    seq,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    sessionId: "m1",
    kind,
    data,
    prev: "",
  };
}

describe("projectReceipt", () => {
  it("verifies when the last check after the last act passed and a review accepted it", () => {
    const receipt = projectReceipt([
      event("node.completed", { node: "act", claim: "done" }),
      event("check.completed", { passed: true, exitCode: 0 }),
      event("review.completed", { accept: true, note: "ok" }),
    ]);
    assert.equal(receipt.status, "VERIFIED");
    assert.equal(receipt.ran.total, 1);
    assert.equal(receipt.ran.failed, 0);
    assert.equal(receipt.notDone, "done");
  });

  it("fails when a check passed before a later act whose check failed", () => {
    const receipt = projectReceipt([
      event("node.completed", { node: "act", claim: "first" }),
      event("check.completed", { passed: true, exitCode: 0 }),
      event("review.completed", { accept: true, note: "ok" }),
      event("node.completed", { node: "act", claim: "second" }),
      event("check.completed", { passed: false, exitCode: 1 }),
    ]);
    assert.equal(receipt.status, "FAILED");
    assert.equal(receipt.ran.total, 2);
    assert.equal(receipt.ran.failed, 1);
  });

  it("never verifies on the agent's claim alone", () => {
    const receipt = projectReceipt([
      event("node.completed", { node: "act", claim: "all tests pass" }),
      event("check.completed", { passed: false, exitCode: 1 }),
    ]);
    assert.equal(receipt.status, "FAILED");
    assert.equal(receipt.notDone, "all tests pass");
  });

  it("fails when the review rejected the last passing check", () => {
    const receipt = projectReceipt([
      event("node.completed", { node: "act" }),
      event("check.completed", { passed: true, exitCode: 0 }),
      event("review.completed", { accept: false, note: "not good enough" }),
    ]);
    assert.equal(receipt.status, "FAILED");
  });

  it("takes the changed lines from the terminal mission record", () => {
    const changed = [{ file: "src/a.txt", ranges: [[1, 3] as [number, number]] }];
    const receipt = projectReceipt([
      event("node.completed", { node: "act" }),
      event("check.completed", { passed: true, exitCode: 0 }),
      event("review.completed", { accept: true, note: "ok" }),
      event("mission.verified", { changes: changed }),
    ]);
    assert.deepEqual(receipt.changed, changed);
    assert.equal(receipt.changedAvailable, true);
  });
});

describe("changedLines", () => {
  const diff = [
    "diff --git a/src/new.txt b/src/new.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.txt",
    "@@ -0,0 +1,3 @@",
    "+one",
    "+two",
    "+three",
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -2 +2 @@",
    "-line two",
    "+line two edited",
    "@@ -10,2 +9,0 @@",
    "-gone one",
    "-gone two",
    "diff --git a/old.txt b/new.txt",
    "similarity index 80%",
    "rename from old.txt",
    "rename to new.txt",
    "--- a/old.txt",
    "+++ b/new.txt",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-changed",
    "+edited",
  ].join("\n");

  it("reads additions, edits, a deletion and a renamed file", () => {
    assert.deepEqual(changedLines(diff), [
      { file: "src/new.txt", ranges: [[1, 3]] },
      { file: "README.md", ranges: [[2, 2]], deletedAt: [10] },
      { file: "new.txt", ranges: [[1, 2]] },
    ]);
  });

  it("reads nothing out of an empty diff", () => {
    assert.deepEqual(changedLines(""), []);
  });
});
