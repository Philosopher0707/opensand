import test from "node:test";
import assert from "node:assert";
import {
  INITIAL_CHAT_TURN,
  formatElapsed,
  isBlankAssistantTurn,
  retryLabel,
  type ChatTurnState,
} from "../src/shell/chat-turn-model.js";
import { previewErrorMessage } from "../src/shell/composer-model.js";

test("elapsed time counts seconds under a minute and switches to minutes after", () => {
  assert.strictEqual(formatElapsed(0), "0s");
  assert.strictEqual(formatElapsed(9), "9s");
  assert.strictEqual(formatElapsed(59), "59s");
  assert.strictEqual(formatElapsed(60), "1m 00s");
  assert.strictEqual(formatElapsed(125), "2m 05s");
});

test("elapsed time is never negative", () => {
  assert.strictEqual(formatElapsed(-5), "0s");
});

const stoppedBlank: ChatTurnState = {
  ...INITIAL_CHAT_TURN,
  status: "stopped",
  messages: [
    { role: "user", text: "hi" },
    { role: "assistant", text: "", note: "Stopped." },
  ],
};

test("a stopped turn with no answer is a blank assistant end", () => {
  assert.strictEqual(isBlankAssistantTurn(stoppedBlank), true);
});

test("a partial answer is not a blank assistant end", () => {
  assert.strictEqual(isBlankAssistantTurn({
    ...stoppedBlank,
    messages: [
      stoppedBlank.messages[0],
      { role: "assistant", text: "half", note: "Stopped." },
    ],
  }), false);
});

test("a thought or a tool card makes an assistant end non-blank", () => {
  assert.strictEqual(isBlankAssistantTurn({
    ...stoppedBlank,
    messages: [stoppedBlank.messages[0], { role: "assistant", text: "", thought: "thinking" }],
  }), false);
  assert.strictEqual(isBlankAssistantTurn({
    ...stoppedBlank,
    messages: [stoppedBlank.messages[0], {
      role: "assistant", text: "", toolCalls: [{ name: "ls", status: "done" }],
    }],
  }), false);
});

test("a user turn or an empty transcript is not a blank assistant end", () => {
  assert.strictEqual(isBlankAssistantTurn(INITIAL_CHAT_TURN), false);
  assert.strictEqual(isBlankAssistantTurn({
    ...stoppedBlank, messages: [{ role: "user", text: "hi" }],
  }), false);
});

test("a stopped turn offers Resume while a failed turn keeps Retry", () => {
  assert.strictEqual(retryLabel("stopped"), "Resume");
  assert.strictEqual(retryLabel("error"), "Retry");
});

test("a preview failure names the file and says the attachment still staged", () => {
  assert.strictEqual(
    previewErrorMessage("photo.png"),
    "Could not make a preview for photo.png. The file is still attached.",
  );
});
