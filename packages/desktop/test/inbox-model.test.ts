import test from "node:test";
import assert from "node:assert";
import {
  sortApprovals,
  formatApprovalTarget,
  formatAsking,
  formatTimestamp,
  toInboxRow,
  inboxEmptyState,
  formatBadgeCount,
  nextIndex,
  type ToolApprovalRequest,
} from "../src/shell/inbox-model.js";

const req = (
  id: string,
  toolName: string,
  args: Record<string, unknown> = {},
  timestamp = 1000,
  reason?: string,
  epoch = 1
): ToolApprovalRequest => ({
  approvalId: id,
  toolName,
  args,
  reason,
  timestamp,
  epoch,
});

test("inbox-model: sortApprovals sorts newest first and breaks ties by id", () => {
  const sorted = sortApprovals([
    req("appr-b", "exec_command", { cmd: "b" }, 1000),
    req("appr-c", "exec_command", { cmd: "c" }, 3000),
    req("appr-a", "exec_command", { cmd: "a" }, 1000),
  ]);
  assert.deepStrictEqual(
    sorted.map((x) => x.approvalId),
    ["appr-c", "appr-a", "appr-b"]
  );
});

test("inbox-model: sortApprovals does not mutate its input", () => {
  const input = [
    req("appr-1", "tool1", {}, 1000),
    req("appr-2", "tool2", {}, 2000),
  ];
  sortApprovals(input);
  assert.deepStrictEqual(
    input.map((x) => x.approvalId),
    ["appr-1", "appr-2"]
  );
});

test("inbox-model: formatApprovalTarget extracts meaningful summaries", () => {
  assert.strictEqual(
    formatApprovalTarget(req("1", "exec_command", { cmd: "pnpm test" })),
    "pnpm test"
  );
  assert.strictEqual(
    formatApprovalTarget(req("2", "exec_command", { command: "git status" })),
    "git status"
  );
  assert.strictEqual(
    formatApprovalTarget(req("3", "write_file", { path: "src/index.ts" })),
    "src/index.ts"
  );
  assert.strictEqual(
    formatApprovalTarget(req("4", "edit_file", { target_file: "packages/a.ts" })),
    "packages/a.ts"
  );
  assert.strictEqual(
    formatApprovalTarget(req("5", "folder.trust", { folder: "/dev/app" })),
    "Trust folder: /dev/app"
  );
  assert.strictEqual(
    formatApprovalTarget(req("6", "custom_tool", {}, 1000, "Needs database migration")),
    "Needs database migration"
  );
  assert.strictEqual(
    formatApprovalTarget(req("7", "http_request", { url: "https://api.github.com" })),
    "https://api.github.com"
  );
  assert.strictEqual(
    formatApprovalTarget(req("8", "empty_tool", {})),
    "empty_tool"
  );
});

test("inbox-model: formatAsking identifies what is asking", () => {
  assert.strictEqual(formatAsking(req("1", "exec_command")), "exec_command");
  assert.strictEqual(formatAsking(req("2", "")), "Agent");
});

test("inbox-model: formatTimestamp formats relative time from millisecond epoch", () => {
  const now = 1700000000000;
  const past = now - 60_000 * 5; // 5 minutes ago
  const formatted = formatTimestamp(past, now);
  assert.strictEqual(formatted, "5 minutes ago");
  assert.strictEqual(formatTimestamp(null, now), "");
});

test("inbox-model: toInboxRow sets active state, labels, and preserves raw request", () => {
  const r = req("appr-99", "exec_command", { cmd: "cargo build" }, 1000, "build binary", 5);
  const rowActive = toInboxRow(r, "just now", "appr-99");
  assert.strictEqual(rowActive.id, "appr-99");
  assert.strictEqual(rowActive.toolName, "exec_command");
  assert.strictEqual(rowActive.askingLabel, "exec_command");
  assert.strictEqual(rowActive.targetDescription, "cargo build");
  assert.strictEqual(rowActive.timeLabel, "just now");
  assert.strictEqual(rowActive.active, true);
  assert.strictEqual(rowActive.raw, r);

  const rowInactive = toInboxRow(r, "just now", "appr-other");
  assert.strictEqual(rowInactive.active, false);
});

test("inbox-model: inboxEmptyState returns expected copy", () => {
  const empty = inboxEmptyState();
  assert.strictEqual(empty.title, "Nothing needs you");
  assert.ok(empty.desc.length > 0);
});

test("inbox-model: formatBadgeCount formats counts and clamps negatives to 0", () => {
  assert.strictEqual(formatBadgeCount(0), "0");
  assert.strictEqual(formatBadgeCount(5), "5");
  assert.strictEqual(formatBadgeCount(-1), "0");
});

test("inbox-model: nextIndex handles ArrowDown, ArrowUp, Home, End clamping", () => {
  assert.strictEqual(nextIndex(0, "ArrowDown", 3), 1);
  assert.strictEqual(nextIndex(2, "ArrowDown", 3), 2);
  assert.strictEqual(nextIndex(1, "ArrowUp", 3), 0);
  assert.strictEqual(nextIndex(0, "ArrowUp", 3), 0);
  assert.strictEqual(nextIndex(1, "Home", 3), 0);
  assert.strictEqual(nextIndex(0, "End", 3), 2);
  assert.strictEqual(nextIndex(1, "x", 3), 1);
  assert.strictEqual(nextIndex(0, "ArrowDown", 0), -1);
});
