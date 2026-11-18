// "Capture window" in the topbar. It sends the same prompt the legacy renderer sends
// and shows the answer here, because the chat view is not ported yet. The state
// machine and the event filter live in src/shell/quick-capture-model.ts.
import { useEffect, useReducer, useRef } from "preact/hooks";
import type { ShellData } from "../data";
import {
  CAPTURE_WINDOWS_PROMPT,
  INITIAL_QUICK_CAPTURE,
  isBusy,
  quickCaptureReducer,
  turnEventAction,
  type QuickCaptureState,
} from "../../../src/shell/quick-capture-model";

export interface QuickCaptureController {
  state: QuickCaptureState;
  available: boolean;
  run: () => void;
  stop: () => void;
  dismiss: () => void;
}

export function useQuickCapture(data: ShellData): QuickCaptureController {
  const available = typeof data.sendQuery === "function";
  const [state, dispatch] = useReducer(
    quickCaptureReducer,
    available ? INITIAL_QUICK_CAPTURE : { ...INITIAL_QUICK_CAPTURE, status: "unavailable" as const },
  );

  // Event handlers read the latest state without re-subscribing on every token.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!data.onTurnEvent) return;
    return data.onTurnEvent((event) => {
      const action = turnEventAction(event, stateRef.current.sessionId);
      if (action) dispatch(action);
    });
  }, [data]);

  const run = () => {
    if (!data.sendQuery || isBusy(stateRef.current.status)) return;
    dispatch({ type: "start" });
    data.sendQuery(CAPTURE_WINDOWS_PROMPT).then(
      (res) => {
        if (res?.success === false) dispatch({ type: "failed", message: "The capture did not start." });
        else dispatch({ type: "sent", sessionId: String(res?.sessionId ?? "") });
      },
      (err) => dispatch({ type: "failed", message: err instanceof Error ? err.message : String(err) }),
    );
  };

  const stop = () => {
    if (data.cancelTurn) Promise.resolve(data.cancelTurn()).catch(() => {});
    dispatch({ type: "stopped" });
  };

  const dismiss = () => dispatch({ type: "dismiss" });

  return { state, available, run, stop, dismiss };
}

export function QuickCaptureButton({ capture }: { capture: QuickCaptureController }) {
  const busy = isBusy(capture.state.status);
  return (
    <button
      type="button"
      class="btn btn-icon-sm"
      id="btnQuickWindow"
      title="Capture window"
      aria-label="Capture window"
      aria-busy={busy}
      disabled={!capture.available || busy}
      onClick={capture.run}
    >
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18" />
      </svg>
    </button>
  );
}

function statusLabel(state: QuickCaptureState): string {
  switch (state.status) {
    case "sending":
      return "Asking for the open windows…";
    case "waiting":
      return "Waiting for your approval in the Inbox.";
    case "streaming":
      return "Receiving the answer…";
    case "done":
      if (state.message) return state.message;
      return state.text ? "Answer ready." : "The agent finished without an answer.";
    case "error":
      return `Capture failed: ${state.message}`;
    case "unavailable":
      return "Capture is not available in this window.";
    default:
      return "";
  }
}

export function QuickCaptureOutput({ capture }: { capture: QuickCaptureController }) {
  const { state } = capture;
  const busy = isBusy(state.status);
  return (
    <div class="quick-capture" data-status={state.status}>
      <div class="quick-capture-bar">
        {/* Always mounted, so the first status change is announced. */}
        <span class="quick-capture-label" role="status" aria-live="polite">
          {statusLabel(state)}
        </span>
        {state.status !== "idle" &&
          (busy ? (
            <button type="button" class="btn btn-sm" onClick={capture.stop}>
              Stop
            </button>
          ) : (
            <button type="button" class="btn btn-sm" onClick={capture.dismiss}>
              Dismiss
            </button>
          ))}
      </div>
      {state.text && (
        <pre class="quick-capture-text" tabIndex={0} aria-label="Captured answer">
          {state.text}
        </pre>
      )}
    </div>
  );
}
