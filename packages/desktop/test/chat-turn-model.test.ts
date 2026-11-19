import test from "node:test";
import assert from "node:assert";
import {
  INITIAL_CHAT_TURN,
  chatEventAction,
  chatTurnReducer,
  isChatBusy,
  type ChatTurnState,
} from "../src/shell/chat-turn-model.js";

const run = (...actions: Parameters<typeof chatTurnReducer>[1][]): ChatTurnState =>
  actions.reduce((s, a) => chatTurnReducer(s, a), INITIAL_CHAT_TURN);

test("a turn goes idle -> sending -> streaming -> done and keeps the transcript", () => {
  const s = run(
    { type: "start", query: "  hello  " },
    { type: "sent", sessionId: "s1" },
    { type: "delta", text: "Hi " },
    { type: "delta", text: "there" },
    { type: "complete" },
  );
  assert.strictEqual(s.status, "done");
  assert.strictEqual(s.sessionId, "s1");
  assert.deepStrictEqual(s.messages, [
    { role: "user", text: "hello" },
    { role: "assistant", text: "Hi there" },
  ]);
});

test("a completed answer with no tokens falls back to the turn's response text", () => {
  const s = run({ type: "start", query: "q" }, { type: "complete", response: "Final answer" });
  assert.strictEqual(s.status, "done");
  assert.strictEqual(s.messages[1].text, "Final answer");
});

test("an error marks the turn and keeps any partial answer, and it is not done", () => {
  const s = run(
    { type: "start", query: "q" },
    { type: "delta", text: "half" },
    { type: "failed", message: "model not found" },
  );
  assert.strictEqual(s.status, "error");
  assert.strictEqual(s.error, "model not found");
  assert.deepStrictEqual(s.messages[1], { role: "assistant", text: "half", error: "model not found" });
  // A late completion after the failure does not turn it into a finished answer.
  assert.strictEqual(chatTurnReducer(s, { type: "complete" }), s);
});

test("Stop keeps the partial answer with a Stopped note and ignores late events", () => {
  const s = run({ type: "start", query: "q" }, { type: "delta", text: "half" }, { type: "stopped" });
  assert.strictEqual(s.status, "stopped");
  assert.deepStrictEqual(s.messages[1], { role: "assistant", text: "half", note: "Stopped." });
  assert.strictEqual(chatTurnReducer(s, { type: "complete" }), s);
  assert.strictEqual(chatTurnReducer(s, { type: "delta", text: " more" }), s);
});

test("a new turn keeps earlier messages and clears the previous error", () => {
  const s = run(
    { type: "start", query: "one" },
    { type: "failed", message: "boom" },
    { type: "start", query: "two" },
  );
  assert.strictEqual(s.status, "sending");
  assert.strictEqual(s.error, "");
  assert.deepStrictEqual(s.messages.map((m) => m.text), ["one", "", "two", ""]);
});

test("an approval pause resumes as streaming on the next token", () => {
  const waiting = run({ type: "start", query: "q" }, { type: "approval" });
  assert.strictEqual(waiting.status, "waiting");
  assert.strictEqual(isChatBusy(waiting.status), true);
  const s = chatTurnReducer(waiting, { type: "delta", text: "ok" });
  assert.strictEqual(s.status, "streaming");
});

test("a second send while busy, and an empty send, change nothing", () => {
  const busy = run({ type: "start", query: "q" }, { type: "delta", text: "x" });
  assert.strictEqual(chatTurnReducer(busy, { type: "start", query: "again" }), busy);
  assert.strictEqual(chatTurnReducer(INITIAL_CHAT_TURN, { type: "start", query: "   " }), INITIAL_CHAT_TURN);
});

test("events for another session are dropped, and each bridge type maps to its action", () => {
  const other = { type: "token", sessionId: "other", data: { token: "leak" } };
  assert.strictEqual(chatEventAction(other, "mine"), null);
  assert.deepStrictEqual(chatEventAction({ type: "token", sessionId: "mine", data: { token: "a" } }, "mine"), {
    type: "delta",
    text: "a",
  });
  assert.deepStrictEqual(chatEventAction({ type: "approval_required" }, null), { type: "approval" });
  assert.deepStrictEqual(chatEventAction({ type: "turn_complete", data: { response: "done" } }, null), {
    type: "complete",
    response: "done",
  });
  assert.deepStrictEqual(chatEventAction({ type: "turn_cancelled" }, null), { type: "stopped" });
  assert.deepStrictEqual(chatEventAction({ type: "error", data: { message: "bad" } }, null), {
    type: "failed",
    message: "bad",
  });
  assert.strictEqual(chatEventAction({ type: "thought", data: { message: "x" } }, null), null);
});
