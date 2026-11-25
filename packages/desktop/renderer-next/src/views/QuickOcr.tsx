// "Recognize screen text" in the topbar. Same send path, event stream and state machine as
// quick window capture; OCR-only outcomes live in ocr-model.ts.
import { useEffect, useReducer, useRef } from "preact/hooks";
import type { ShellData } from "../data";
import {
  INITIAL_QUICK_CAPTURE,
  isBusy,
  type QuickCaptureState,
} from "../../../src/shell/quick-capture-model";
import { OCR_PROMPT, ocrEventAction, ocrReducer, plainOcrError } from "../../../src/shell/ocr-model";

export interface QuickOcrController {
  state: QuickCaptureState;
  available: boolean;
  run: () => void;
  stop: () => void;
  dismiss: () => void;
}

export function useQuickOcr(data: ShellData): QuickOcrController {
  const available = typeof data.sendQuery === "function";
  const [state, dispatch] = useReducer(
    ocrReducer,
    available ? INITIAL_QUICK_CAPTURE : { ...INITIAL_QUICK_CAPTURE, status: "unavailable" as const },
  );

  // Event handlers read the latest state without re-subscribing on every token.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!data.onTurnEvent) return;
    return data.onTurnEvent((event) => {
      const action = ocrEventAction(event, stateRef.current.sessionId);
      if (action) dispatch(action);
    });
  }, [data]);

  const run = () => {
    if (!data.sendQuery || isBusy(stateRef.current.status)) return;
    dispatch({ type: "start" });
    data.sendQuery(OCR_PROMPT).then(
      (res) => {
        if (res?.success === false) dispatch({ type: "failed", message: plainOcrError("send failed") });
        else dispatch({ type: "sent", sessionId: String(res?.sessionId ?? "") });
      },
      // The rejection is never inspected: no raw engine error can reach the panel.
      () => dispatch({ type: "failed", message: plainOcrError("send failed") }),
    );
  };

  const stop = () => {
    if (data.cancelTurn) Promise.resolve(data.cancelTurn()).catch(() => {});
    dispatch({ type: "stopped" });
  };

  const dismiss = () => dispatch({ type: "dismiss" });

  return { state, available, run, stop, dismiss };
}

export function QuickOcrButton({ ocr }: { ocr: QuickOcrController }) {
  const busy = isBusy(ocr.state.status);
  return (
    <button
      type="button"
      class="btn btn-icon-sm"
      id="btnQuickOcr"
      title="Recognize screen text"
      aria-label="Recognize screen text"
      aria-busy={busy}
      disabled={!ocr.available || busy}
      onClick={ocr.run}
    >
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  );
}

function statusLabel(state: QuickCaptureState): string {
  switch (state.status) {
    case "sending":
      return "Reading the screen…";
    case "waiting":
      return "Waiting for your approval in the Inbox.";
    case "streaming":
      return "Reading the text…";
    case "done":
      return state.message || (state.text ? "Text ready." : "The scan finished without text.");
    case "error":
      return state.message;
    case "unavailable":
      return "Text recognition is not available in this window.";
    default:
      return "";
  }
}

export function QuickOcrOutput({ ocr }: { ocr: QuickOcrController }) {
  const { state } = ocr;
  const busy = isBusy(state.status);
  return (
    <div class="quick-capture quick-ocr" data-status={state.status} data-tool="ocr">
      <div class="quick-capture-bar">
        {/* Always mounted, so the first status change is announced. */}
        <span class="quick-capture-label" role="status" aria-live="polite">
          {busy && <span class="quick-capture-spinner" aria-hidden="true" />}
          {statusLabel(state)}
        </span>
        {state.status !== "idle" &&
          (busy ? (
            <button type="button" class="btn btn-sm" onClick={ocr.stop}>
              Stop
            </button>
          ) : (
            <button type="button" class="btn btn-sm" onClick={ocr.dismiss}>
              Dismiss
            </button>
          ))}
      </div>
      {state.text && (
        <pre class="quick-capture-text" tabIndex={0} aria-label="Recognized text">
          {state.text}
        </pre>
      )}
    </div>
  );
}
