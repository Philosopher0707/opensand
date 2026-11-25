import test from "node:test";
import assert from "node:assert";
import { friendlyChatError } from "../src/shell/composer-model.js";
import { chatEventAction } from "../src/shell/chat-turn-model.js";

const FALLBACK = "The agent could not finish that turn. Try again, or use Retry.";

// Untrusted bridge text: paths, URLs, connection strings, bodies, stacks, credential shapes.
const RAW_ERRORS = [
  "ENOENT: /Users/example/.opensand/private/session.json",
  "request failed for https://api.example.test/v1/chat?account=private",
  "connect ECONNREFUSED 10.0.0.4:5432 user=demo-user password=demo-pass",
  'HTTP 500 {"message":"upstream body","token":"demo-token-1234"}',
  "TypeError: x is not a function\n  at handler (/Users/example/app.js:12:3)",
  "Bearer demo-token-1234 for account=demo@example.test",
  "404 Not Found: https://example.test/v1/models/secret-model",
];

function assertNoLeak(text: string, raw: string): void {
  assert.ok(!text.includes(raw), `raw bridge text reached the UI: ${text}`);
  assert.ok(!text.includes("/Users/"), "absolute path reached the UI");
  assert.ok(!text.includes("https://"), "URL reached the UI");
  assert.ok(!text.includes("ECONNREFUSED"), "connection string reached the UI");
  assert.ok(!text.includes("demo-token-1234"), "credential-shaped text reached the UI");
  assert.ok(!/at \S+:\d+:\d+/.test(text), "stack frame reached the UI");
}

test("friendlyChatError fails closed for unknown and raw bridge text", () => {
  for (const raw of RAW_ERRORS) {
    assert.strictEqual(friendlyChatError(raw), FALLBACK);
    assert.strictEqual(friendlyChatError(raw, "UNKNOWN_ERROR"), FALLBACK);
    assert.strictEqual(friendlyChatError(raw, "NOT_A_REAL_CODE"), FALLBACK);
    assert.strictEqual(friendlyChatError(raw, "toString"), FALLBACK);
    assert.strictEqual(friendlyChatError(raw, 42), FALLBACK);
  }
  assert.strictEqual(friendlyChatError("model not found"), FALLBACK);
  assert.strictEqual(friendlyChatError(""), FALLBACK);
});

test("friendlyChatError keeps only fixed phrases and code-derived lines", () => {
  assert.strictEqual(friendlyChatError("Unknown error occurred"), "Unknown error occurred");
  assert.strictEqual(friendlyChatError("The message did not send. Try again."), "The message did not send. Try again.");
  for (const raw of RAW_ERRORS) {
    const safe = friendlyChatError(raw, "FILE_NOT_FOUND");
    assert.strictEqual(safe, "The requested file or directory does not exist. Check the path in your workspace.");
    assertNoLeak(safe, raw);
  }
});

test("chatEventAction never forwards bridge error text into a failed turn", () => {
  for (const raw of RAW_ERRORS) {
    const byMessage = chatEventAction({ type: "error", data: { message: raw } }, null);
    assert.deepStrictEqual(byMessage, { type: "failed", message: FALLBACK });
    assertNoLeak((byMessage as any).message, raw);

    // classifyError's UNKNOWN_ERROR wraps the raw message as cause; it must not pass through.
    const byCause = chatEventAction(
      { type: "error", data: { cause: raw, nextAction: "See https://example.test/docs", code: "UNKNOWN_ERROR" } },
      null,
    );
    assert.deepStrictEqual(byCause, { type: "failed", message: FALLBACK });
    assertNoLeak((byCause as any).message, raw);

    const byCode = chatEventAction(
      { type: "error", data: { cause: raw, nextAction: "Retry", code: "RATE_LIMIT_EXCEEDED" } },
      null,
    );
    assertNoLeak((byCode as any).message, raw);
  }
});
