import test from "node:test";
import assert from "node:assert";
import {
  LEARNED_RULES_DONE,
  LEARNED_RULES_EMPTY,
  LEARNED_RULES_LOADING,
  LEARNED_RULES_REFRESHING,
  reportSummary,
  rulesContent,
} from "../src/shell/learned-rules-model.js";

test("learned-rules-model: content falls back to the empty message", () => {
  assert.strictEqual(rulesContent({ content: "  use pnpm  " }), "use pnpm");
  assert.strictEqual(rulesContent({ content: "   " }), LEARNED_RULES_EMPTY);
  assert.strictEqual(rulesContent(null), LEARNED_RULES_EMPTY);
});

test("learned-rules-model: report prefers markdown, then summary, then done", () => {
  assert.strictEqual(reportSummary({ markdownSummary: " **md** ", summary: "plain" }), "**md**");
  assert.strictEqual(reportSummary({ summary: " plain " }), "plain");
  assert.strictEqual(reportSummary({}), LEARNED_RULES_DONE);
  assert.strictEqual(reportSummary(null), LEARNED_RULES_DONE);
});

test("learned-rules-model: loading and refreshing copy", () => {
  assert.ok(LEARNED_RULES_LOADING.includes("Loading"));
  assert.ok(LEARNED_RULES_REFRESHING.includes("Re-analyzing"));
});
