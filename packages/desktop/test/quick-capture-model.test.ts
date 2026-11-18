import test from "node:test";
import assert from "node:assert";
import {
  CAPTURE_WINDOWS_PROMPT,
  INITIAL_QUICK_CAPTURE,
  isBusy,
  quickCaptureReducer,
  turnEventAction,
  type QuickCaptureState,
} from "../src/shell/quick-capture-model.js";

const run = (...actions: Parameters<typeof quickCaptureReducer>[1][]): QuickCaptureState =>
  actions.reduce((s, a) => quickCaptureReducer(s, a), INITIAL_QUICK_CAPTURE);

test("the capture prompt is the one the legacy button sends", () => {
  assert.strictEqual(CAPTURE_WINDOWS_PROMPT, "Call list_windows and show all open on-screen windows.");
});

test("a capture goes idle -> sending -> streaming -> done and keeps the streamed text", () => {
  const s = run(
    { type: "start" },
    { type: "sent", sessionId: "s1" },
    { type: "delta", text: "Safari, " },
    { type: "delta", text: "Notes" },
    { type: "complete" },
  );
  assert.deepStrictEqual(s, { status: "done", text: "Safari, Notes", message: "", sessionId: "s1" });
});

test("a second start while a capture is busy changes nothing", () => {
  const busy = run({ type: "start" }, { type: "delta", text: "partial" });
  assert.strictEqual(quickCaptureReducer(busy, { type: "start" }), busy);
});

test("a send that resolves after the turn already finished does not reopen the panel", () => {
  const done = run({ type: "start" }, { type: "complete" });
  assert.strictEqual(quickCaptureReducer(done, { type: "sent", sessionId: "late" }), done);
});

test("a failed send or a bridge error ends in error with the message", () => {
  assert.deepStrictEqual(run({ type: "start" }, { type: "failed", message: "no key" }), {
    status: "error",
    text: "",
    message: "no key",
    sessionId: null,
  });
});

test("events are ignored when no capture is running", () => {
  assert.strictEqual(quickCaptureReducer(INITIAL_QUICK_CAPTURE, { type: "delta", text: "x" }), INITIAL_QUICK_CAPTURE);
  assert.strictEqual(quickCaptureReducer(INITIAL_QUICK_CAPTURE, { type: "complete" }), INITIAL_QUICK_CAPTURE);
  assert.strictEqual(quickCaptureReducer(INITIAL_QUICK_CAPTURE, { type: "failed", message: "x" }), INITIAL_QUICK_CAPTURE);
});

test("Stop ends a busy capture at once, even with no terminal event from the engine", () => {
  const s = run({ type: "start" }, { type: "delta", text: "half" }, { type: "stopped" });
  assert.deepStrictEqual(s, { status: "done", text: "half", message: "Stopped.", sessionId: null });
  // A late terminal event after Stop does not change the stopped panel.
  assert.strictEqual(quickCaptureReducer(s, { type: "complete" }), s);
  assert.strictEqual(quickCaptureReducer(s, { type: "delta", text: " more" }), s);
});

test("dismiss clears a finished panel but not a running one", () => {
  const busy = run({ type: "start" });
  assert.strictEqual(quickCaptureReducer(busy, { type: "dismiss" }), busy);
  const done = run({ type: "start" }, { type: "complete" });
  assert.deepStrictEqual(quickCaptureReducer(done, { type: "dismiss" }), INITIAL_QUICK_CAPTURE);
});

test("unavailable is its own state, and not a busy one", () => {
  const unavailable = quickCaptureReducer(INITIAL_QUICK_CAPTURE, { type: "unavailable" });
  assert.strictEqual(unavailable.status, "unavailable");
  assert.strictEqual(isBusy(unavailable.status), false);
});

test("isBusy is true only while sending, waiting for approval or streaming", () => {
  assert.deepStrictEqual(
    (["idle", "sending", "waiting", "streaming", "done", "error", "unavailable"] as const).map(isBusy),
    [false, true, true, true, false, false, false],
  );
});

test("an approval request pauses a capture, and the next token resumes it", () => {
  const paused = run({ type: "start" }, { type: "sent", sessionId: "s1" }, { type: "approval" });
  assert.strictEqual(paused.status, "waiting");
  assert.strictEqual(paused.sessionId, "s1");
  const resumed = quickCaptureReducer(paused, { type: "delta", text: "Safari" });
  assert.deepStrictEqual(resumed, { status: "streaming", text: "Safari", message: "", sessionId: "s1" });
});

test("a send that resolves while the capture waits for approval keeps the wait and takes the session", () => {
  const waiting = run({ type: "start" }, { type: "approval" });
  const sent = quickCaptureReducer(waiting, { type: "sent", sessionId: "s2" });
  assert.deepStrictEqual(sent, { status: "waiting", text: "", message: "", sessionId: "s2" });
});

test("an approval request after the capture finished does not reopen it", () => {
  const done = run({ type: "start" }, { type: "complete" });
  assert.strictEqual(quickCaptureReducer(done, { type: "approval" }), done);
});

test("Stop ends a capture that waits for approval", () => {
  const waiting = run({ type: "start" }, { type: "approval" });
  assert.strictEqual(quickCaptureReducer(waiting, { type: "stopped" }).status, "done");
});

test("turnEventAction maps tokens, completion and errors, and ignores other events", () => {
  assert.deepStrictEqual(turnEventAction({ type: "token", data: { token: "Hi" } }, null), { type: "delta", text: "Hi" });
  assert.deepStrictEqual(turnEventAction({ type: "text_delta", token: "x" }, null), { type: "delta", text: "x" });
  assert.strictEqual(turnEventAction({ type: "token", data: { token: "" } }, null), null);
  assert.deepStrictEqual(turnEventAction({ type: "approval_required" }, null), { type: "approval" });
  assert.deepStrictEqual(turnEventAction({ type: "turn_complete" }, null), { type: "complete" });
  assert.deepStrictEqual(turnEventAction({ type: "error", data: { message: "boom" } }, null), { type: "failed", message: "boom" });
  assert.deepStrictEqual(turnEventAction({ type: "error" }, null), { type: "failed", message: "Unknown error occurred" });
  assert.strictEqual(turnEventAction({ type: "thought", data: { token: "hmm" } }, null), null);
});

test("turnEventAction drops an event from another session once this capture knows its session", () => {
  assert.strictEqual(turnEventAction({ type: "token", sessionId: "other", token: "x" }, "mine"), null);
  assert.strictEqual(turnEventAction({ type: "turn_complete", data: { sessionId: "other" } }, "mine"), null);
  assert.deepStrictEqual(turnEventAction({ type: "token", sessionId: "mine", token: "x" }, "mine"), { type: "delta", text: "x" });
  // Before the send returns the session, events are accepted: the panel is already busy.
  assert.deepStrictEqual(turnEventAction({ type: "token", sessionId: "other", token: "x" }, null), { type: "delta", text: "x" });
});
