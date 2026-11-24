import test from "node:test";
import assert from "node:assert";
import {
  BTW_NO_ANSWER,
  BTW_VALIDATION_MESSAGE,
  COMPACT_DEFAULT_KEEP,
  ROLLBACK_DEFAULT_TURNS,
  actionErrorMessage,
  btwAnswer,
  compactMessage,
  parsePositive,
  rollbackMessage,
  validateBtw,
} from "../src/shell/session-actions-model.js";

test("session-actions-model: BTW validation and answer fallback", () => {
  assert.strictEqual(validateBtw("  why? "), null);
  assert.strictEqual(validateBtw(""), BTW_VALIDATION_MESSAGE);
  assert.strictEqual(validateBtw("   "), BTW_VALIDATION_MESSAGE);
  assert.strictEqual(btwAnswer({ answer: "  because  " }), "because");
  assert.strictEqual(btwAnswer({}), BTW_NO_ANSWER);
});

test("session-actions-model: numeric fields use the legacy defaults", () => {
  assert.strictEqual(parsePositive("4", ROLLBACK_DEFAULT_TURNS), 4);
  assert.strictEqual(parsePositive("", ROLLBACK_DEFAULT_TURNS), 1);
  assert.strictEqual(parsePositive("abc", COMPACT_DEFAULT_KEEP), 2);
});

test("session-actions-model: success and error messages", () => {
  assert.strictEqual(rollbackMessage({ removedMessages: 2, remainingMessages: 5 }),
    "Successfully rolled back 2 messages. Remaining in context: 5.");
  assert.strictEqual(rollbackMessage({}), "Successfully rolled back 0 messages. Remaining in context: 0.");
  assert.strictEqual(compactMessage({ originalTokens: 100, compactedTokens: 40, compactedTurnCount: 3 }),
    "Auto-Compaction succeeded! Original: ~100 tokens -> Compacted: ~40 tokens (condensed 3 turns).");
  assert.strictEqual(actionErrorMessage(new Error("boom")), "Error: boom");
});
