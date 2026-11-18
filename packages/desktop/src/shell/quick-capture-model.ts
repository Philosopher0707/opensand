// Quick window capture: state machine for the topbar "Capture window" button.
// Pure, so the transitions and the event filter are tested without Electron.

/** The prompt the legacy renderer sends for the same button (renderer/app.js, Quick Tools). */
export const CAPTURE_WINDOWS_PROMPT = "Call list_windows and show all open on-screen windows.";

export type QuickCaptureStatus = "idle" | "sending" | "waiting" | "streaming" | "done" | "error" | "unavailable";

export interface QuickCaptureState {
  status: QuickCaptureStatus;
  /** Answer text streamed so far. */
  text: string;
  /** Error message, when status is "error". */
  message: string;
  /** Session the turn runs in, once the send has returned it. */
  sessionId: string | null;
}

export const INITIAL_QUICK_CAPTURE: QuickCaptureState = {
  status: "idle",
  text: "",
  message: "",
  sessionId: null,
};

export type QuickCaptureAction =
  | { type: "start" }
  | { type: "sent"; sessionId: string }
  | { type: "failed"; message: string }
  | { type: "delta"; text: string }
  | { type: "approval" }
  | { type: "complete" }
  | { type: "stopped" }
  | { type: "dismiss" }
  | { type: "unavailable" };

/** A turn event as the desktop bridge delivers it (`window.opensand.onEvent`). */
export interface TurnEvent {
  type: string;
  sessionId?: string;
  token?: string;
  text?: string;
  message?: string;
  data?: { token?: string; message?: string; sessionId?: string } | null;
}

export function isBusy(status: QuickCaptureStatus): boolean {
  return status === "sending" || status === "waiting" || status === "streaming";
}

export function quickCaptureReducer(state: QuickCaptureState, action: QuickCaptureAction): QuickCaptureState {
  switch (action.type) {
    case "start":
      // A second press while a capture runs is ignored; the button is disabled then anyway.
      if (isBusy(state.status)) return state;
      return { ...INITIAL_QUICK_CAPTURE, status: "sending" };
    case "sent":
      // The send can resolve after the turn already finished, or after an approval arrived; only a busy capture takes the id.
      if (!isBusy(state.status)) return state;
      return { ...state, sessionId: action.sessionId };
    case "failed":
      if (!isBusy(state.status)) return state;
      return { ...state, status: "error", message: action.message };
    case "delta":
      if (!isBusy(state.status) || !action.text) return state;
      return { ...state, status: "streaming", text: state.text + action.text };
    case "approval":
      // The turn is paused until the person answers in the Inbox; the next token or completion resumes it.
      if (!isBusy(state.status)) return state;
      return { ...state, status: "waiting" };
    case "complete":
      if (!isBusy(state.status)) return state;
      return { ...state, status: "done" };
    case "stopped":
      // Stop ends the panel at once, even when the engine sends no terminal event after cancel.
      if (!isBusy(state.status)) return state;
      return { ...state, status: "done", message: "Stopped." };
    case "dismiss":
      // The answer cannot be dismissed while the turn still runs; Stop is the way out then.
      if (isBusy(state.status)) return state;
      return INITIAL_QUICK_CAPTURE;
    case "unavailable":
      return { ...INITIAL_QUICK_CAPTURE, status: "unavailable" };
  }
}

/**
 * Maps a bridge event to a reducer action, or null when it is not for this capture.
 * An event that names a session is ignored when it is not the captured session, so a
 * turn started in another window does not fill this panel.
 */
export function turnEventAction(event: TurnEvent, sessionId: string | null): QuickCaptureAction | null {
  const eventSession = event.sessionId ?? event.data?.sessionId;
  if (sessionId && eventSession && eventSession !== sessionId) return null;

  if (event.type === "token" || event.type === "text_delta") {
    const delta = event.data?.token || event.token || event.text || "";
    return delta ? { type: "delta", text: delta } : null;
  }
  if (event.type === "approval_required") return { type: "approval" };
  if (event.type === "turn_complete") return { type: "complete" };
  if (event.type === "error") {
    return { type: "failed", message: event.data?.message || event.message || "Unknown error occurred" };
  }
  return null;
}
