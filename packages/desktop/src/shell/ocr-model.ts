// Phase 5 row 1: "Recognize screen text". The OCR tool result arrives as a turn event on the
// same send/IPC path as quick window capture. Classify it here so the panel only ever shows
// a plain outcome, never the raw Vision error, image path or engine message.
import {
  isBusy,
  quickCaptureReducer,
  turnEventAction,
  type QuickCaptureAction,
  type QuickCaptureState,
  type TurnEvent,
} from "./quick-capture-model.js";

/** The prompt the legacy renderer sends for the same button. */
export const OCR_PROMPT = "Call recognize_screen_text and extract text from the screen.";
export const OCR_TOOL_NAME = "recognize_screen_text";

export type OcrAction = QuickCaptureAction | { type: "notice"; message: string };

/** A no-text result ends the scan without colouring it as a failure. */
export function ocrReducer(state: QuickCaptureState, action: OcrAction): QuickCaptureState {
  if (action.type === "notice") {
    return isBusy(state.status) ? { ...state, status: "done", message: action.message } : state;
  }
  return quickCaptureReducer(state, action);
}

/** Engine and tool failures are reduced to plain words: no paths, stderr or raw model errors. */
export function plainOcrError(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  if (/unsupported|not supported|invalid format|unknown format|decode/i.test(text)) {
    return "That image format isn't supported.";
  }
  if (/too large|exceeds|size limit|maximum/i.test(text)) {
    return "That image is too large to scan.";
  }
  return "The text scan failed. Please try again.";
}

/** Tool results may be an object or a JSON string wrapped as untrusted text by the coordinator. */
function resultObject(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof value === "string") {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      value = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Maps OCR turn events to the shared capture state machine, plus the no-text notice. */
export function ocrEventAction(event: TurnEvent, sessionId: string | null): OcrAction | null {
  const base = turnEventAction(event, sessionId);
  if (base?.type === "failed") return { ...base, message: plainOcrError(base.message) };
  if (base) return base;

  const eventSession = event.sessionId ?? event.data?.sessionId;
  if (sessionId && eventSession && eventSession !== sessionId) return null;
  if (event.type !== "tool_result" && event.type !== "tool_call_completed") return null;
  const name = event.data?.name ?? event.name ?? event.toolCall?.function?.name;
  if (name !== OCR_TOOL_NAME) return null;

  const raw = event.result !== undefined
    ? event.result
    : (event.data?.result !== undefined ? event.data.result : (event.output ?? event.data?.output));
  const result = resultObject(raw);
  if (!result) return null;
  if (result.status === "error" || result.isError === true) {
    return { type: "failed", message: plainOcrError(result.message) };
  }
  if (result.status === "ok" && !(typeof result.text === "string" && result.text.trim())) {
    return { type: "notice", message: "No text found in the image." };
  }
  // Text found: the agent's streamed answer carries it to the panel, as in quick window capture.
  return null;
}
