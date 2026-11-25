import test from "node:test";
import assert from "node:assert";
import {
  EMPTY_SEND_QUEUE,
  SEND_FAILURE_MESSAGE,
  cancelQueuedMessage,
  clearSendQueue,
  enqueueMessage,
  queueStatusLabel,
  sendFailureMessage,
  takeNextQueued,
} from "../src/shell/chat-send-queue.js";

test("an empty queue has no indicator and nothing to drain", () => {
  assert.strictEqual(queueStatusLabel(EMPTY_SEND_QUEUE.items.length), "");
  assert.deepStrictEqual(takeNextQueued(EMPTY_SEND_QUEUE), { state: EMPTY_SEND_QUEUE, text: null });
  assert.strictEqual(enqueueMessage(EMPTY_SEND_QUEUE, "   "), EMPTY_SEND_QUEUE);
  assert.strictEqual(clearSendQueue(EMPTY_SEND_QUEUE), EMPTY_SEND_QUEUE);
});

test("cancelling one queued item removes only that item", () => {
  const two = enqueueMessage(enqueueMessage(EMPTY_SEND_QUEUE, "first"), "second");
  assert.strictEqual(queueStatusLabel(two.items.length), "2 queued messages");
  const firstId = two.items[0].id;
  const one = cancelQueuedMessage(two, firstId);
  assert.deepStrictEqual(one.items.map((item) => item.text), ["second"]);
  assert.strictEqual(queueStatusLabel(one.items.length), "1 queued message");
  assert.strictEqual(cancelQueuedMessage(one, 999), one, "an unknown id is a no-op");
});

test("a failed send surfaces a plain message, never the raw provider error", () => {
  const raw = "ECONNRESET at /api/chat line 42: provider-secret";
  const message = sendFailureMessage(new Error(raw));
  assert.strictEqual(message, SEND_FAILURE_MESSAGE);
  assert.ok(!message.includes(raw));
  assert.ok(!/ECONN|\/api\/chat|provider-secret|line 42/.test(message));
});

test("follow-ups drain FIFO when a turn ends and are cleared on failure or stop", () => {
  const two = enqueueMessage(enqueueMessage(EMPTY_SEND_QUEUE, "first"), "second");
  const first = takeNextQueued(two);
  assert.strictEqual(first.text, "first");
  assert.deepStrictEqual(first.state.items.map((item) => item.text), ["second"]);
  const second = takeNextQueued(first.state);
  assert.strictEqual(second.text, "second");
  assert.strictEqual(takeNextQueued(second.state).text, null);
  assert.deepStrictEqual(clearSendQueue(two).items, []);
});
