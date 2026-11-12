import test from "node:test";
import assert from "node:assert";
import {
  filterSessions,
  toRow,
  emptyState,
  relativeTime,
  type SessionSummary,
} from "../src/shell/session-list-model.js";

test("session-list-model: filterSessions filters by title", () => {
  const sessions: SessionSummary[] = [
    { id: "1", title: "Project Alpha" },
    { id: "2", title: "Beta Testing" },
  ];
  const res = filterSessions(sessions, "Alpha");
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].id, "1");
});

test("session-list-model: filterSessions filters by id when title is empty", () => {
  const sessions: SessionSummary[] = [
    { id: "sess-abc-123", title: "" },
    { id: "sess-xyz-789", title: "" },
  ];
  const res = filterSessions(sessions, "abc");
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].id, "sess-abc-123");
});

test("session-list-model: filterSessions is case-insensitive and trims whitespace", () => {
  const sessions: SessionSummary[] = [
    { id: "1", title: "OpenSand Architecture" },
    { id: "2", title: "Documentation" },
  ];
  const res = filterSessions(sessions, "  ARCH  ");
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].id, "1");
});

test("session-list-model: emptyState returns match and default states", () => {
  const match = emptyState("test-query");
  assert.ok(match);
  assert.strictEqual(match.title, "No conversations match");
  assert.strictEqual(match.desc, "No conversation has “test-query” in its name.");

  const empty = emptyState("");
  assert.ok(empty);
  assert.strictEqual(empty.title, "No conversations yet");
  assert.strictEqual(empty.desc, "Start a conversation with a Bot and it shows up here.");

  const emptyWhitespace = emptyState("   ");
  assert.ok(emptyWhitespace);
  assert.strictEqual(emptyWhitespace.title, "No conversations yet");
});

test("session-list-model: toRow handles title, id, count, and avatar fallbacks", () => {
  const now = 1700000000000;

  // Title empty -> falls back to id
  const rowIdFallback = toRow({ id: "custom-id-99", title: "" }, now);
  assert.strictEqual(rowIdFallback.title, "custom-id-99");
  assert.strictEqual(rowIdFallback.avatar, "C");

  // Both empty -> "New conversation"
  const rowBothEmpty = toRow({ id: "", title: "" }, now);
  assert.strictEqual(rowBothEmpty.title, "New conversation");
  assert.strictEqual(rowBothEmpty.avatar, "N");

  // messageCount 0 -> "New conversation"
  const rowZeroMsg = toRow({ id: "1", title: "Chat", messageCount: 0 }, now);
  assert.strictEqual(rowZeroMsg.snippet, "New conversation");

  // messageCount 3 -> "3 messages"
  const rowThreeMsg = toRow({ id: "1", title: "Chat", messageCount: 3 }, now);
  assert.strictEqual(rowThreeMsg.snippet, "3 messages");

  // active state
  const rowActive = toRow({ id: "session-active", title: "Chat" }, now, "session-active");
  assert.strictEqual(rowActive.active, true);
  const rowInactive = toRow({ id: "session-inactive", title: "Chat" }, now, "session-active");
  assert.strictEqual(rowInactive.active, false);
});

test("session-list-model: relativeTime formats seconds, minutes, days and handles invalid dates", () => {
  const fixedNow = new Date("2026-06-01T12:00:00.000Z").getTime();

  // 30 seconds ago
  const sec30 = new Date(fixedNow - 30_000).toISOString();
  assert.strictEqual(relativeTime(sec30, fixedNow), "30 seconds ago");

  // 5 minutes ago
  const min5 = new Date(fixedNow - 5 * 60_000).toISOString();
  assert.strictEqual(relativeTime(min5, fixedNow), "5 minutes ago");

  // 2 days ago
  const day2 = new Date(fixedNow - 2 * 86_400_000).toISOString();
  assert.strictEqual(relativeTime(day2, fixedNow), "2 days ago");

  // Invalid date string -> ""
  assert.strictEqual(relativeTime("not-a-valid-date", fixedNow), "");

  // Null / undefined -> ""
  assert.strictEqual(relativeTime(null, fixedNow), "");
  assert.strictEqual(relativeTime(undefined, fixedNow), "");
});
