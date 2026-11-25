import test from "node:test";
import assert from "node:assert";
import {
  DICTATION_LABELS,
  createDictationController,
  dictationNotice,
  dictationText,
  type DictationEvents,
  type DictationResultEvent,
  type DictationState,
  type SpeechRecognitionLike,
} from "../src/shell/dictation-model.js";

class FakeRecognition implements SpeechRecognitionLike {
  continuous = false;
  interimResults = false;
  lang = "";
  calls: string[] = [];
  onstart: (() => void) | null = null;
  onresult: ((event: DictationResultEvent) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;

  start() { this.calls.push("start"); this.onstart?.(); }
  stop() { this.calls.push("stop"); this.onend?.(); }
  abort() { this.calls.push("abort"); this.onend?.(); }

  result(final: string, interim = "") {
    const results = [
      { isFinal: Boolean(final), 0: { transcript: final } },
      { isFinal: false, 0: { transcript: interim } },
    ];
    this.onresult?.({ resultIndex: 0, results });
  }

  error(code: string) {
    this.onerror?.({ error: code });
  }
}

function harness(recognition: SpeechRecognitionLike | null, initialText = "") {
  const texts: string[] = [];
  const states: DictationState[] = [];
  const notices: string[] = [];
  let value = initialText;
  const events: DictationEvents = {
    getBaseText: () => value,
    onText: (text) => { value = text; texts.push(text); },
    onState: (state) => states.push(state),
    onNotice: (message) => { if (message) notices.push(message); },
  };
  const controller = createDictationController(recognition, events);
  return {
    controller,
    texts,
    states,
    notices,
    get value() { return value; },
    set value(next: string) { value = next; },
  };
}

test("starting configures the legacy Web Speech API shape and announces listening", () => {
  const recognition = new FakeRecognition();
  const h = harness(recognition);
  h.controller.start();
  assert.strictEqual(recognition.continuous, true);
  assert.strictEqual(recognition.interimResults, true);
  assert.strictEqual(recognition.lang, "en-US");
  assert.deepStrictEqual(h.states, ["listening"]);
  assert.strictEqual(DICTATION_LABELS.listening, "Listening...");
});

test("interim and final results replace the draft from the captured base text", () => {
  const recognition = new FakeRecognition();
  const h = harness(recognition, "Draft:");
  h.controller.start();
  recognition.result("", "hello");
  assert.strictEqual(h.value, "Draft: hello");
  recognition.result("hello world");
  assert.strictEqual(h.value, "Draft: hello world");
});

test("empty speech inserts nothing at all", () => {
  const recognition = new FakeRecognition();
  const h = harness(recognition, "unchanged");
  h.controller.start();
  recognition.result("");
  recognition.result("   ", "  ");
  assert.strictEqual(dictationText("unchanged", "", ""), null);
  assert.deepStrictEqual(h.texts, []);
  assert.strictEqual(h.value, "unchanged");
});

test("stop ends listening and keeps the final transcript", () => {
  const recognition = new FakeRecognition();
  const h = harness(recognition);
  h.controller.start();
  recognition.result("kept");
  h.controller.stop();
  assert.ok(recognition.calls.includes("stop"));
  assert.deepStrictEqual(h.states, ["listening", "idle"]);
  assert.strictEqual(h.value, "kept");
  // A second stop is a no-op: no extra IPC-style calls, no extra state changes.
  h.controller.stop();
  assert.strictEqual(recognition.calls.filter((c) => c === "stop").length, 1);
});

test("cancel aborts and restores the pre-dictation text", () => {
  const recognition = new FakeRecognition();
  const h = harness(recognition, "before");
  h.controller.start();
  recognition.result("", "half-heard words");
  h.controller.cancel();
  assert.ok(recognition.calls.includes("abort"));
  assert.deepStrictEqual(h.states, ["listening", "idle"]);
  assert.strictEqual(h.value, "before");
});

test("permission denied shows a plain message with no raw error text", () => {
  const recognition = new FakeRecognition();
  const h = harness(recognition);
  h.controller.start();
  recognition.error("not-allowed");
  assert.strictEqual(h.notices[0], dictationNotice("not-allowed"));
  assert.match(h.notices[0], /Microphone access was denied/);
  assert.ok(!h.notices[0].includes("not-allowed"));
  assert.deepStrictEqual(h.states, ["listening", "idle"]);
});

test("any error leaves the button idle and never echoes raw text", () => {
  for (const code of ["audio-capture", "aborted", "network", "internal NotAllowedError at file:///Users/me/key"]) {
    const recognition = new FakeRecognition();
    const h = harness(recognition);
    h.controller.start();
    recognition.error(code);
    assert.strictEqual(h.states.at(-1), "idle", `idle after ${code}`);
    assert.strictEqual(h.notices.length, 1);
    assert.ok(!h.notices[0].includes(code), `raw error leaked for ${code}`);
    assert.ok(!h.notices[0].includes("NotAllowedError"));
    assert.ok(!h.notices[0].includes("file:///"));
  }
});

test("a late onend after an error does not re-toggle the button", () => {
  const recognition = new FakeRecognition();
  const h = harness(recognition);
  h.controller.start();
  recognition.error("no-speech");
  recognition.onend?.();
  assert.deepStrictEqual(h.states, ["listening", "idle"]);
});

test("unsupported browser and a failing start stay idle with a plain notice", () => {
  const unsupported = harness(null);
  unsupported.controller.start();
  assert.deepStrictEqual(unsupported.states, []);
  assert.match(unsupported.notices[0], /not supported in this browser/);

  const recognition = new FakeRecognition();
  recognition.start = () => { throw new Error("raw start failure"); };
  const h = harness(recognition);
  h.controller.start();
  assert.deepStrictEqual(h.states, []);
  assert.strictEqual(h.notices.length, 1);
  assert.ok(!h.notices[0].includes("raw start failure"));
});
