// Completeness-audit rows 3, 6, 8 and 9: four dead desktop actions.
// Tests are written against small shell models so the wiring stays observable without a UI.
import test from "node:test";
import assert from "node:assert";
import {
  OPEN_ROLLBACK_EVENT,
  OPEN_COMPACT_EVENT,
  openSettingsHash,
  sessionActionForEvent,
} from "../src/shell/dead-actions-model.js";
import { querySendArgs } from "../src/shell/query-send-model.js";
import {
  INITIAL_CHAT_TURN,
  canRetryTurn,
  chatTurnReducer,
  type ChatTurnState,
} from "../src/shell/chat-turn-model.js";

test("row 3: the Settings menu event navigates the renderer to #settings", () => {
  const win = { location: { hash: "#chat" } };
  openSettingsHash(win);
  assert.strictEqual(win.location.hash, "#settings");
});

test("row 6: the Inspector rewind event resolves to the rollback action", () => {
  assert.strictEqual(sessionActionForEvent(OPEN_ROLLBACK_EVENT, true), "rollback");
  assert.strictEqual(sessionActionForEvent(OPEN_COMPACT_EVENT, true), "compact");
  assert.strictEqual(sessionActionForEvent("opensand:anything_else", true), null);
});

test("row 6 failure path: the events do nothing while no session is selected", () => {
  assert.strictEqual(sessionActionForEvent(OPEN_ROLLBACK_EVENT, false), null);
  assert.strictEqual(sessionActionForEvent(OPEN_COMPACT_EVENT, false), null);
});

test("row 8: sendQuery carries the selected session and active agent to the IPC bridge", () => {
  assert.deepStrictEqual(querySendArgs("hello", "sess-7", "agent-3"), ["hello", "sess-7", "agent-3"]);
  assert.deepStrictEqual(querySendArgs("hello", null, undefined), ["hello", undefined, undefined]);
});

const withTurn = (...actions: Parameters<typeof chatTurnReducer>[1][]): ChatTurnState =>
  actions.reduce((state, action) => chatTurnReducer(state, action), INITIAL_CHAT_TURN);

test("row 9: Retry is available for an error and for a stopped turn", () => {
  const failed = withTurn({ type: "start", query: "hello" }, { type: "failed", message: "offline" });
  const stopped = withTurn({ type: "start", query: "hello" }, { type: "stopped" });
  assert.strictEqual(failed.status, "error");
  assert.strictEqual(stopped.status, "stopped");
  assert.strictEqual(canRetryTurn(failed), true);
  assert.strictEqual(canRetryTurn(stopped), true);
});

test("row 9 failure path: Retry is hidden without a previous user message", () => {
  assert.strictEqual(canRetryTurn(INITIAL_CHAT_TURN), false);
  assert.strictEqual(canRetryTurn({ ...INITIAL_CHAT_TURN, status: "error" }), false);
  assert.strictEqual(canRetryTurn({ ...INITIAL_CHAT_TURN, status: "stopped" }), false);
  const busy = withTurn({ type: "start", query: "hello" });
  assert.strictEqual(canRetryTurn(busy), false, "a running turn must never offer Retry");
});
