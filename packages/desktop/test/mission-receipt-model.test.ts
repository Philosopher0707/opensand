import test from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventLogWriter } from "@opensand/shared";
import { localizeTimestamps, buildReceiptView, displayPath, formatDuration, formatChecks, formatChanged } from "../src/shell/mission-receipt-model.js";
import { readMissionReceipt } from "../src/shell/mission-receipt-source.js";

const receipt = {
  status: "VERIFIED",
  summary: "check exited 0 (2 runs)",
  changed: [{ file: "src/a.ts", ranges: [[46, 171], [200, 200]] }, { file: "src/gone.ts", ranges: [], deletedAt: [3] }],
  changedAvailable: true,
  ran: { total: 2, failed: 1, lastExitCode: 0, runs: [{ exitCode: 1, passed: false, ts: "x" }] },
  notDone: "Windows path handling",
};
const ev = (seq: number, kind: string, ts: string, data: any = {}) => ({ seq, kind, ts, data });

test("buildReceiptView: finished mission yields display fields", () => {
  const v = buildReceiptView([
    ev(1, "mission.started", "2026-11-14T09:00:00.000Z", { title: "t" }),
    ev(2, "mission.verified", "2026-11-14T09:07:12.000Z", { receipt, changes: [{ file: "SECRET", ranges: [[1, 2]] }] }),
  ])!;
  assert.strictEqual(v.status, "VERIFIED");
  assert.deepStrictEqual(v.checks, { total: 2, failed: 1, lastExitCode: 0 });
  assert.deepStrictEqual(v.changed, [{ file: "src/a.ts", lines: "46-171, 200" }, { file: "src/gone.ts", lines: "(deleted)" }]);
  assert.strictEqual(v.durationMs, 432000);
  assert.strictEqual(v.notDone, "Windows path handling");
  assert.ok(!JSON.stringify(v).includes("SECRET"), "the raw changes list is not copied");
});

test("buildReceiptView: no receipt yet gives null", () => {
  assert.strictEqual(buildReceiptView([]), null);
  assert.strictEqual(buildReceiptView([ev(1, "mission.started", "2026-11-14T09:00:00.000Z")]), null);
  assert.strictEqual(buildReceiptView([ev(1, "mission.failed", "2026-11-14T09:00:00.000Z", { error: { message: "x" } })]), null);
});

test("buildReceiptView: failed and stopped missions keep their own status", () => {
  const failed = buildReceiptView([ev(1, "mission.failed", "2026-11-14T09:00:00.000Z", { receipt: { ...receipt, status: "FAILED" } })])!;
  assert.strictEqual(failed.status, "FAILED");
  assert.strictEqual(failed.durationMs, null);
  const stopped = buildReceiptView([ev(1, "mission.stopped", "2026-11-14T09:00:00.000Z", { receipt: { ...receipt, status: "FAILED" } })])!;
  assert.strictEqual(stopped.status, "STOPPED");
});

test("buildReceiptView: unavailable changes carry the reason", () => {
  const v = buildReceiptView([ev(1, "mission.verified", "2026-11-14T09:00:00.000Z", { receipt: { ...receipt, changed: [], changedAvailable: false, changedReason: "not a git repository" } })])!;
  assert.strictEqual(formatChanged(v), "Not available (not a git repository)");
});

test("displayPath never shows an absolute or home path", () => {
  assert.strictEqual(displayPath("src/a.ts"), "src/a.ts");
  assert.strictEqual(displayPath("/Users/someone/dev/app/src/a.ts"), "…/src/a.ts");
  assert.strictEqual(displayPath("C:\\Users\\x\\app\\b.ts"), "…/app/b.ts");
  assert.strictEqual(displayPath("~/secrets/key.pem"), "…/secrets/key.pem");
});

test("formatters", () => {
  assert.strictEqual(formatDuration(432000), "7m 12s");
  assert.strictEqual(formatDuration(null), "—");
  assert.strictEqual(formatDuration(4500), "5s");
  assert.strictEqual(formatChecks({ total: 1, failed: 0, lastExitCode: 0 }), "1 command, 0 non-zero (last exit 0)");
  assert.strictEqual(formatChanged({ changedAvailable: true, changed: [] } as any), "No files changed");
});

test("readMissionReceipt validates the id and returns null for unknown or receipt-less missions", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-receipt-"));
  try {
    for (const bad of ["../x", "a/b", "", ".hidden", 5, null]) await assert.rejects(() => readMissionReceipt(base, bad), /Invalid mission id/);
    assert.strictEqual(await readMissionReceipt(base, "missing"), null);
    const w = new EventLogWriter(path.join(base, "missions", "m1"), { sessionId: "m1" });
    await w.append({ kind: "mission.started" as any, data: { title: "t" }, ts: "2026-11-14T09:00:00.000Z" });
    assert.strictEqual(await readMissionReceipt(base, "m1"), null);
    await w.append({ kind: "mission.verified" as any, data: { receipt }, ts: "2026-11-14T09:01:00.000Z" });
    assert.strictEqual((await readMissionReceipt(base, "m1"))!.status, "VERIFIED");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("receipt summary shows local 24h time, not ISO", () => {
  assert.strictEqual(localizeTimestamps("check exited 0 (2 runs: 1 failed, passed at 2026-11-14T09:01:20.000Z)", "Asia/Kolkata"), "check exited 0 (2 runs: 1 failed, passed at 14:31:20)");
  assert.strictEqual(localizeTimestamps("no stamp here", "UTC"), "no stamp here");
  const v = buildReceiptView([ev(1, "mission.verified", "2026-11-14T09:00:00.000Z", { receipt: { ...receipt, summary: "passed at 2026-11-14T09:01:20.000Z" } })])!;
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(v.summary), "buildReceiptView localizes the summary");
});
