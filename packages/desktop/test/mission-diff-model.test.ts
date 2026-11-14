import test from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventLogWriter } from "@opensand/shared";
import { parseUnifiedDiff, diffNote, DIFF_MAX_BYTES } from "../src/shell/mission-diff-model.js";
import { readMissionFileDiff } from "../src/shell/mission-diff-source.js";
import { makeRepoWithChange } from "./git-fixture.js";

const DIFF = [
  "diff --git a/src/a.txt b/src/a.txt",
  "index 1..2 100644",
  "--- a/src/a.txt",
  "+++ b/src/a.txt",
  "@@ -1,3 +1,4 @@",
  " one",
  "-two",
  "+TWO changed",
  " three",
  "+four",
  "\\ No newline at end of file",
  "",
].join("\n");

test("parseUnifiedDiff keeps hunks and line kinds, drops file headers", () => {
  const p = parseUnifiedDiff(DIFF);
  assert.strictEqual(p.hunks.length, 1);
  assert.strictEqual(p.hunks[0].header, "@@ -1,3 +1,4 @@");
  assert.deepStrictEqual(p.hunks[0].lines.map((l) => l.kind), ["ctx", "del", "add", "ctx", "add"]);
  assert.strictEqual(p.hunks[0].lines[2].text, "TWO changed");
});

test("parseUnifiedDiff flags binary files and runaway line counts", () => {
  assert.strictEqual(parseUnifiedDiff("Binary files a/x and b/x differ\n").binary, true);
  const big = "@@ -1 +1 @@\n" + "+x\n".repeat(5000);
  assert.strictEqual(parseUnifiedDiff(big).tooManyLines, true);
});

test("diffNote words each non-ready state", () => {
  assert.match(diffNote({ state: "unavailable", file: "a" })!, /no longer available/);
  assert.match(diffNote({ state: "too-large", file: "a" })!, /too large to show/);
  assert.match(diffNote({ state: "binary", file: "a" })!, /Binary/);
  assert.strictEqual(diffNote({ state: "ready", file: "a", hunks: [{ header: "@@", lines: [] }] }), null);
});

async function missionDir(home: string, id: string, started: any, terminal: any) {
  const w = new EventLogWriter(path.join(home, "missions", id), { sessionId: id });
  await w.append({ kind: "mission.started" as any, data: started, ts: "2026-11-14T09:00:00.000Z" });
  await w.append({ kind: "mission.verified" as any, data: terminal, ts: "2026-11-14T09:01:00.000Z" });
}

test("readMissionFileDiff returns only the requested file's hunks, found by index", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-diff-"));
  try {
    const repo = path.join(home, "repo");
    const { baseTree, finalTree, file } = makeRepoWithChange(repo);
    const receipt = { status: "VERIFIED", changed: [{ file, ranges: [[2, 4]] }, { file: "other.txt", ranges: [[1, 1]] }] };
    await missionDir(home, "m1", { workspaceRoot: repo }, { receipt, baseTree, finalTree });
    const v: any = await readMissionFileDiff(home, "m1", 0);
    assert.strictEqual(v.state, "ready");
    assert.strictEqual(v.file, file);
    assert.ok(v.hunks[0].lines.some((l: any) => l.kind === "add" && l.text === "TWO changed"));
    assert.ok(!JSON.stringify(v).includes(repo), "no absolute path crosses IPC");
    // other.txt did not change between the trees: no hunks, never another file's content.
    const other: any = await readMissionFileDiff(home, "m1", 1);
    assert.strictEqual(other.state, "ready");
    assert.deepStrictEqual(other.hunks, []);
    assert.strictEqual(await readMissionFileDiff(home, "m1", 7), null, "an index outside the receipt is refused");
    await assert.rejects(readMissionFileDiff(home, "../x", 0), /Invalid mission id/);
    await assert.rejects(readMissionFileDiff(home, "m1", -1), /Invalid file index/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a log without tree ids, or with pruned objects, is 'unavailable'", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-diff-"));
  try {
    const repo = path.join(home, "repo");
    const { file } = makeRepoWithChange(repo);
    const receipt = { status: "VERIFIED", changed: [{ file, ranges: [[2, 4]] }] };
    await missionDir(home, "old", { workspaceRoot: repo }, { receipt });
    assert.strictEqual(((await readMissionFileDiff(home, "old", 0)) as any).state, "unavailable");
    const gone = "a".repeat(40);
    await missionDir(home, "pruned", { workspaceRoot: repo }, { receipt, baseTree: gone, finalTree: "b".repeat(40) });
    assert.strictEqual(((await readMissionFileDiff(home, "pruned", 0)) as any).state, "unavailable");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a huge diff is 'too-large'", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-diff-"));
  try {
    const repo = path.join(home, "repo");
    const { baseTree, file } = makeRepoWithChange(repo);
    fs.writeFileSync(path.join(repo, file), "line of text that is long enough\n".repeat(Math.ceil(DIFF_MAX_BYTES / 20)));
    const { git } = await import("./git-fixture.js");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "big");
    const finalTree = git(repo, "rev-parse", "HEAD^{tree}");
    const receipt = { status: "VERIFIED", changed: [{ file, ranges: [[1, 9]] }] };
    await missionDir(home, "big", { workspaceRoot: repo }, { receipt, baseTree, finalTree });
    assert.strictEqual(((await readMissionFileDiff(home, "big", 0)) as any).state, "too-large");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
