import test from "node:test";
import assert from "node:assert";
import { INITIAL_QUICK_CAPTURE, isBusy, type QuickCaptureState } from "../src/shell/quick-capture-model.js";
import {
  OCR_PROMPT,
  OCR_TOOL_NAME,
  ocrEventAction,
  ocrReducer,
  plainOcrError,
  type OcrAction,
} from "../src/shell/ocr-model.js";

const run = (...actions: OcrAction[]): QuickCaptureState =>
  actions.reduce((s, a) => ocrReducer(s, a), INITIAL_QUICK_CAPTURE);

const toolResult = (result: unknown, name = OCR_TOOL_NAME) => ({
  type: "tool_result",
  data: { name, result },
});

test("the OCR prompt is the one the legacy button sends", () => {
  assert.strictEqual(OCR_PROMPT, "Call recognize_screen_text and extract text from the screen.");
});

test("an unsupported image gives a plain format message, not the tool detail", () => {
  const action = ocrEventAction(toolResult({ status: "error", message: "Failed to decode image data: /Users/philosopher/a.gif" }), null);
  assert.deepStrictEqual(action, { type: "failed", message: "That image format isn't supported." });
  assert.ok(!JSON.stringify(action).includes("/Users/"));
  assert.strictEqual(plainOcrError("Unsupported file extension .tiff"), "That image format isn't supported.");
});

test("an oversized image gives a plain size message", () => {
  assert.deepStrictEqual(
    ocrEventAction(toolResult({ status: "error", message: "image exceeds 20 MB limit" }), null),
    { type: "failed", message: "That image is too large to scan." },
  );
  assert.strictEqual(plainOcrError("Maximum image size is 20MB"), "That image is too large to scan.");
});

test("an image with no text ends as a notice, not a failure, and later tokens are dropped", () => {
  const notice = ocrEventAction(toolResult({ status: "ok", text: "", blocks: [] }), null);
  assert.deepStrictEqual(notice, { type: "notice", message: "No text found in the image." });
  const done = run({ type: "start" }, notice!);
  assert.strictEqual(done.status, "done");
  assert.strictEqual(done.message, "No text found in the image.");
  assert.strictEqual(ocrReducer(done, { type: "delta", text: "late" }), done);
  assert.strictEqual(ocrReducer(done, { type: "notice", message: "again" }), done);
});

test("a JSON-string tool result wrapped as untrusted text is still classified", () => {
  const raw = '<untrusted source="recognize_screen_text">\n{"status":"ok","text":"   "}\n</untrusted>';
  assert.deepStrictEqual(ocrEventAction(toolResult(raw), null), { type: "notice", message: "No text found in the image." });
});

test("an OCR failure is reported plainly with no raw error or path", () => {
  const engineError = ocrEventAction({
    type: "error",
    data: { message: "sand-vision exited 1: Vision request failed at /Users/philosopher/Pictures/s.png" },
  }, null);
  assert.deepStrictEqual(engineError, { type: "failed", message: "The text scan failed. Please try again." });
  const sendFailure = run({ type: "start" }, engineError!);
  assert.strictEqual(sendFailure.status, "error");
  assert.ok(!sendFailure.message.includes("/Users/"));
  assert.ok(!sendFailure.message.includes("sand-vision"));
});

test("a spinner-worthy scan can be stopped, and a late completion cannot reopen it", () => {
  const sending = run({ type: "start" });
  assert.strictEqual(isBusy(sending.status), true);
  const streaming = ocrReducer(sending, { type: "delta", text: "HELLO" });
  assert.strictEqual(isBusy(streaming.status), true);
  const stopped = ocrReducer(streaming, { type: "stopped" });
  assert.deepStrictEqual(stopped, { status: "done", text: "HELLO", message: "Stopped.", sessionId: null });
  assert.strictEqual(ocrReducer(stopped, { type: "complete" }), stopped);
});

test("other tools' results and other sessions' events do not drive the OCR panel", () => {
  assert.strictEqual(ocrEventAction(toolResult({ status: "error", message: "boom" }, "list_windows"), null), null);
  assert.strictEqual(
    ocrEventAction({ ...toolResult({ status: "ok", text: "" }), sessionId: "other" }, "mine"),
    null,
  );
  assert.deepStrictEqual(
    ocrEventAction({ ...toolResult({ status: "ok", text: "" }), sessionId: "mine" }, "mine"),
    { type: "notice", message: "No text found in the image." },
  );
});
