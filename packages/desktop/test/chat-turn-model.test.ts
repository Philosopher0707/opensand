import test from "node:test";
import assert from "node:assert";
import type { ToolApprovalRequest } from "../src/types.js";
import {
  INITIAL_CHAT_TURN,
  approvalErrorMessage,
  chatEventAction,
  chatTurnReducer,
  isChatBusy,
  rateLimitRetryLabel,
  reconstructSessionMessages,
  type ChatMessage,
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

const approvalRequest = (): ToolApprovalRequest => ({
  approvalId: "appr-1",
  toolName: "exec_command",
  args: { cmd: "echo hi" },
  reason: "Run the check",
  timestamp: 1,
  epoch: 7,
});

test("an approval pause resumes as streaming on the next token", () => {
  const waiting = run({ type: "start", query: "q" }, { type: "approval", request: null });
  assert.strictEqual(waiting.status, "waiting");
  assert.strictEqual(isChatBusy(waiting.status), true);
  const s = chatTurnReducer(waiting, { type: "delta", text: "ok" });
  assert.strictEqual(s.status, "streaming");
});

test("approval_required keeps the payload and approval_resolved clears the card exactly once", () => {
  const req = approvalRequest();
  const waiting = chatTurnReducer(run({ type: "start", query: "q" }), {
    type: "approval",
    request: req,
  });
  assert.strictEqual(waiting.status, "waiting");
  assert.deepStrictEqual(waiting.approval, req);

  const resolved = chatEventAction(
    { type: "approval_resolved", data: { approvalId: req.approvalId, action: "approve_modified" } },
    null,
  );
  assert.deepStrictEqual(resolved, { type: "approval_resolved", approvalId: "appr-1" });
  const cleared = chatTurnReducer(waiting, resolved!);
  assert.strictEqual(cleared.approval, null);
  assert.strictEqual(cleared.status, "streaming");
  // A duplicate event, or one for another card, must not clear anything twice.
  assert.strictEqual(chatTurnReducer(cleared, resolved!), cleared);
  assert.strictEqual(chatTurnReducer(waiting, { type: "approval_resolved", approvalId: "other" }), waiting);
});

test("a cancelled turn closes an open card with a plain cancelled note", () => {
  const waiting = chatTurnReducer(run({ type: "start", query: "q" }), {
    type: "approval",
    request: approvalRequest(),
  });
  const stopped = chatTurnReducer(waiting, { type: "stopped" });
  assert.strictEqual(stopped.approval, null);
  assert.strictEqual(stopped.status, "stopped");
  assert.strictEqual(stopped.approvalCancelled, true);
  assert.strictEqual(stopped.messages[stopped.messages.length - 1].note, "Approval cancelled.");
});

test("approval failures get plain words and keep the card open for a retry", () => {
  assert.strictEqual(approvalErrorMessage({ code: 4001, message: "stale epoch" }), "That approval changed; reload and try again.");
  assert.strictEqual(approvalErrorMessage({ status: 409 }), "That approval changed; reload and try again.");
  assert.strictEqual(approvalErrorMessage(new Error("Request timed out")), "The approval took too long to go through. Try again.");
  assert.strictEqual(approvalErrorMessage(new Error("socket gone")), "That approval did not go through. Try again.");
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
  assert.deepStrictEqual(chatEventAction({ type: "approval_required" }, null), { type: "approval", request: null });
  const req = approvalRequest();
  assert.deepStrictEqual(chatEventAction({ type: "approval_required", data: { ...req } }, null), {
    type: "approval",
    request: req,
  });
  assert.deepStrictEqual(chatEventAction({ type: "turn_complete", data: { response: "done" } }, null), {
    type: "complete",
    response: "done",
  });
  assert.deepStrictEqual(chatEventAction({ type: "turn_cancelled" }, null), { type: "stopped" });
  assert.deepStrictEqual(chatEventAction({ type: "error", data: { message: "bad" } }, null), {
    type: "failed",
    message: "bad",
  });
});

test("load action hydrates session messages and resets status to idle", () => {
  const loadedMessages: ChatMessage[] = [
    { role: "user", text: "What is 2+2?" },
    { role: "assistant", text: "4" },
  ];
  // 1. From INITIAL_CHAT_TURN
  const s1 = chatTurnReducer(INITIAL_CHAT_TURN, {
    type: "load",
    sessionId: "sess-history-1",
    messages: loadedMessages,
  });
  assert.strictEqual(s1.status, "idle");
  assert.strictEqual(s1.sessionId, "sess-history-1");
  assert.strictEqual(s1.error, "");
  assert.deepStrictEqual(s1.messages, loadedMessages);

  // 2. From busy / error state, load resets status to idle and clears error
  const busyState = run(
    { type: "start", query: "something" },
    { type: "failed", message: "network timeout" },
  );
  assert.strictEqual(busyState.status, "error");
  const s2 = chatTurnReducer(busyState, {
    type: "load",
    sessionId: "sess-history-2",
    messages: loadedMessages,
  });
  assert.strictEqual(s2.status, "idle");
  assert.strictEqual(s2.sessionId, "sess-history-2");
  assert.strictEqual(s2.error, "");
  assert.deepStrictEqual(s2.messages, loadedMessages);

  // 3. New turn after load keeps loaded messages and appends new query
  const s3 = chatTurnReducer(s2, { type: "start", query: "next question" });
  assert.strictEqual(s3.status, "sending");
  assert.strictEqual(s3.messages.length, 4);
  assert.strictEqual(s3.messages[2].role, "user");
  assert.strictEqual(s3.messages[2].text, "next question");
});

test("reconstructSessionMessages extracts turns from jsonl events", () => {
  const events = [
    { role: "user", content: "Hello world" },
    { role: "assistant", content: "<think>thinking deep</think>Hi there!" },
  ];
  const messages = reconstructSessionMessages({ events });
  assert.deepStrictEqual(messages, [
    { role: "user", text: "Hello world" },
    { role: "assistant", text: "Hi there!", thought: "thinking deep" },
  ]);
});

test("reconstructSessionMessages falls back to transcript text", () => {
  const transcript = "<user_query>\nWhat is the capital of France?\n</user_query>\nassistant:\nParis\n";
  const messages = reconstructSessionMessages({ transcript });
  assert.deepStrictEqual(messages, [
    { role: "user", text: "What is the capital of France?" },
    { role: "assistant", text: "Paris" },
  ]);
});

test("reconstructSessionMessages handles empty, null, or malformed session data safely", () => {
  assert.deepStrictEqual(reconstructSessionMessages(null), []);
  assert.deepStrictEqual(reconstructSessionMessages(undefined), []);
  assert.deepStrictEqual(reconstructSessionMessages({}), []);
  assert.deepStrictEqual(reconstructSessionMessages({ events: [] }), []);
  assert.deepStrictEqual(reconstructSessionMessages({ transcript: "" }), []);
});

test("chatEventAction maps thought and tool events", () => {
  // Thought event
  assert.deepStrictEqual(
    chatEventAction({ type: "thought", data: { thought: "pondering problem" } }, null),
    { type: "thought", text: "pondering problem" }
  );
  assert.deepStrictEqual(
    chatEventAction({ type: "thought_delta", text: "step 1" }, null),
    { type: "thought", text: "step 1" }
  );

  // Tool call event
  assert.deepStrictEqual(
    chatEventAction(
      { type: "tool_call", data: { name: "exec_command", args: { cmd: "echo hi" } } },
      null
    ),
    {
      type: "tool_call",
      tool: { name: "exec_command", args: { cmd: "echo hi" }, status: "running" },
    }
  );

  // Tool result event
  assert.deepStrictEqual(
    chatEventAction(
      { type: "tool_result", data: { name: "exec_command", result: "hi\n" } },
      null
    ),
    {
      type: "tool_result",
      tool: { name: "exec_command", result: "hi\n", status: "done" },
    }
  );
});

test("a turn accumulates thought blocks and tracks tool call execution in message parts", () => {
  const s = run(
    { type: "start", query: "run a command" },
    { type: "sent", sessionId: "s2" },
    { type: "thought", text: "First, check the directory." },
    {
      type: "tool_call",
      tool: { id: "tc-1", name: "exec_command", args: { cmd: "ls" }, status: "running" },
    },
    {
      type: "tool_result",
      tool: { id: "tc-1", name: "exec_command", result: "file1.txt\nfile2.txt", status: "done" },
    },
    { type: "delta", text: "I found 2 files." },
    { type: "complete" }
  );

  assert.strictEqual(s.status, "done");
  const assistant = s.messages[1];
  assert.strictEqual(assistant.text, "I found 2 files.");
  assert.strictEqual(assistant.thought, "First, check the directory.");
  assert.deepStrictEqual(assistant.toolCalls, [
    {
      id: "tc-1",
      name: "exec_command",
      args: { cmd: "ls" },
      status: "done",
      result: "file1.txt\nfile2.txt",
    },
  ]);
});

test("streaming text with inline <think> tags extracts thought into structured field", () => {
  const s = run(
    { type: "start", query: "solve problem" },
    { type: "delta", text: "<think>Let me calculate 2+2=4</think>The answer is 4." },
    { type: "complete" }
  );
  assert.strictEqual(s.status, "done");
  assert.strictEqual(s.messages[1].text, "The answer is 4.");
  assert.strictEqual(s.messages[1].thought, "Let me calculate 2+2=4");
});

test("streaming text across paced chunks preserves exact text without dropping deltas", () => {
  const chunks = [
    "CHAT ANSWER: the workspace has three packages.\n\nThe desktop ",
    "package owns the Electron main process and the bridge; the engine package runs the local model loop and the mission store; the protocol pack",
    "age carries the message shapes both sides share.\n\nFor a first change, start in packages/desktop/src/shell: the models there are pure state machines, so they test without Electron and the views stay thin.",
  ];
  const s = run(
    { type: "start", query: "summarize" },
    ...chunks.map((text) => ({ type: "delta" as const, text })),
    { type: "complete" }
  );
  assert.strictEqual(s.status, "done");
  assert.strictEqual(s.messages[1].text, chunks.join(""));
  assert.strictEqual(s.messages[1]._rawText, undefined);
});

test("a retry event drives a live rate-limit label and the turn keeps its user message", () => {
  const now = 1_700_000_000_000;
  const event = {
    type: "retry",
    sessionId: "s1",
    data: { attempt: 2, maxRetries: 6, delayMs: 7000, status: 429, provider: "openrouter", retryAt: now + 7000 },
  };
  assert.deepStrictEqual(chatEventAction(event, "s1"), {
    type: "retry",
    notice: { provider: "openrouter", attempt: 2, maxRetries: 6, retryAt: now + 7000 },
  });

  const busy = run({ type: "start", query: "hi" }, { type: "sent", sessionId: "s1" });
  const retrying = chatTurnReducer(busy, chatEventAction(event, "s1") as any);
  assert.strictEqual(retrying.status, "sending");
  assert.strictEqual(retrying.messages[0].text, "hi", "the user's message stays for Retry");
  assert.strictEqual(
    rateLimitRetryLabel(retrying.retry, now),
    "Rate limited by openrouter — retrying in 7s (attempt 2/6)"
  );
  assert.strictEqual(
    rateLimitRetryLabel(retrying.retry, now + 3000),
    "Rate limited by openrouter — retrying in 4s (attempt 2/6)"
  );

  // Stop clears the wait immediately; a late retry event cannot resurrect it.
  const stopped = chatTurnReducer(retrying, { type: "stopped" });
  assert.strictEqual(stopped.retry, null);
  assert.strictEqual(stopped.messages[0].text, "hi");
  assert.strictEqual(chatTurnReducer(stopped, chatEventAction(event, "s1") as any), stopped);
});

test("a failed turn clears the retry label and the Retry button becomes available", () => {
  const retrying = run(
    { type: "start", query: "hi" },
    { type: "retry", notice: { attempt: 1, maxRetries: 6, retryAt: 1_700_000_000_000 } }
  );
  assert.ok(retrying.retry);
  const failed = chatTurnReducer(retrying, { type: "failed", message: "still rate limited" });
  assert.strictEqual(failed.retry, null);
  assert.strictEqual(failed.status, "error");
  assert.strictEqual(rateLimitRetryLabel(failed.retry), null);
  assert.ok(failed.messages.some((m) => m.role === "user"), "the message stays for Retry");
});
