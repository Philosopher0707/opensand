import { useState, useEffect } from "preact/hooks";
import type { ShellData } from "../data";
import { formatChanged, formatChecks, formatDuration, type ReceiptView } from "../../../src/shell/mission-receipt-model";

export interface MissionReceiptProps {
  data: ShellData;
  missionId: string;
}

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; receipt: ReceiptView | null };

const TONE = { VERIFIED: "ok", FAILED: "bad", STOPPED: "attention" } as const;

export function MissionReceipt({ data, missionId }: MissionReceiptProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoad({ state: "loading" });
    data
      .getMissionReceipt(missionId)
      .then((receipt) => {
        if (mounted) setLoad({ state: "ready", receipt });
      })
      .catch(() => {
        if (mounted) setLoad({ state: "error" });
      });
    return () => {
      mounted = false;
    };
  }, [data, missionId, attempt]);

  // No receipt yet (still running, or ended without one) shows nothing, not an error.
  if (load.state === "loading" || (load.state === "ready" && !load.receipt)) return null;
  if (load.state === "error") {
    return (
      <div class="mission-error mission-receipt-error" role="alert">
        <span>Could not load this mission's receipt.</span>
        <button type="button" class="btn-retry" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
      </div>
    );
  }
  const r = load.receipt as ReceiptView;
  return (
    <section class={`mission-receipt receipt-${TONE[r.status]}`} aria-labelledby="missionReceiptHeading" data-receipt-status={r.status}>
      <h2 class="mission-timeline-heading" id="missionReceiptHeading">Receipt</h2>
      <dl class="receipt-rows">
        <dt>Outcome</dt>
        <dd class="receipt-outcome"><strong>{r.status}</strong>{r.summary ? <span class="receipt-summary"> {r.summary}</span> : null}</dd>
        <dt>Checks</dt>
        <dd class="receipt-checks">{formatChecks(r.checks)}</dd>
        <dt>Changed</dt>
        <dd class="receipt-changed">
          {formatChanged(r)}
          {r.changed.length > 0 && (
            <ul class="receipt-files">
              {r.changed.map((f) => (
                <li key={f.file}><code>{f.file}</code>{f.lines ? <span class="receipt-lines">{f.lines}</span> : null}</li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Time</dt>
        <dd class="receipt-time">{formatDuration(r.durationMs)}</dd>
        <dt>Not done</dt>
        <dd class="receipt-open">{r.notDone ? <>{r.notDone} <span class="receipt-muted">(model note; unverified)</span></> : <span class="receipt-muted">Nothing left open</span>}</dd>
      </dl>
    </section>
  );
}
