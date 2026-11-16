import { useState, useEffect, useRef } from "preact/hooks";
import type { ShellData } from "../data";
import { RestoreDialog } from "./RestoreDialog";
import { ForkDialog } from "./ForkDialog";
import {
  classifyRestoreError,
  restoreSuccessView,
  type PreviewRestoreResult,
} from "../../../src/shell/mission-restore-model";
import {
  classifyForkError,
  forkSuccessView,
} from "../../../src/shell/mission-fork-model";
import {
  toTimelineSteps,
  windowSteps,
  nextLimit,
  timelineEmptyState,
  formatStepTime,
  TIMELINE_PAGE,
  type TimelineStep,
} from "../../../src/shell/mission-timeline-model";

export interface MissionTimelineProps {
  data: ShellData;
  missionId: string;
  onSelectMission?: (newMissionId: string) => void;
}

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; steps: TimelineStep[] };

export function MissionTimeline({ data, missionId, onSelectMission }: MissionTimelineProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [limit, setLimit] = useState(TIMELINE_PAGE);
  const [attempt, setAttempt] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);

  // Restore dialog state
  const [pending, setPending] = useState<TimelineStep | null>(null);
  const [preview, setPreview] = useState<PreviewRestoreResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // Fork dialog state
  const [pendingFork, setPendingFork] = useState<TimelineStep | null>(null);
  const [forkPreview, setForkPreview] = useState<PreviewRestoreResult | null>(null);
  const [forkPreviewLoading, setForkPreviewLoading] = useState(false);
  const [forkPreviewError, setForkPreviewError] = useState<string | null>(null);
  const [forkRecoveryHint, setForkRecoveryHint] = useState<string | null>(null);
  const [forkBusy, setForkBusy] = useState(false);
  const [forkDialogError, setForkDialogError] = useState<string | null>(null);

  const [toast, setToast] = useState<{ tone: "ok" | "bad"; message: string; undo?: string } | null>(null);

  const openRestore = (step: TimelineStep) => {
    setDialogError(null);
    setPreviewError(null);
    setPreview(null);
    setPending(step);
    setPreviewLoading(true);
    data
      .previewRestoreMissionSnapshot(missionId, step.snapshot!)
      .then((res) => {
        setPreview(res);
      })
      .catch((err) => {
        const e = classifyRestoreError(err);
        setPreviewError(e.message);
      })
      .finally(() => {
        setPreviewLoading(false);
      });
  };

  const closeRestore = () => {
    setPending(null);
    setPreview(null);
    setPreviewError(null);
    setDialogError(null);
  };

  const runRestore = async (snapshot: string, isUndo: boolean) => {
    setBusy(true);
    setDialogError(null);
    try {
      const res = await data.restoreMissionSnapshot(missionId, snapshot);
      const view = restoreSuccessView(res);
      closeRestore();
      setToast({ tone: "ok", message: isUndo ? "Restore undone." : view.message, undo: isUndo ? undefined : view.undoSnapshot });
    } catch (err) {
      const e = classifyRestoreError(err);
      if (isUndo) {
        setToast({ tone: "bad", message: e.message });
      } else {
        setDialogError(e.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const openFork = (step: TimelineStep) => {
    setForkDialogError(null);
    setForkPreviewError(null);
    setForkRecoveryHint(null);
    setForkPreview(null);
    setPendingFork(step);
    setForkPreviewLoading(true);
    data
      .previewRestoreMissionSnapshot(missionId, step.snapshot!)
      .then((res) => {
        setForkPreview(res);
      })
      .catch((err) => {
        const e = classifyForkError(err);
        setForkPreviewError(e.message);
        setForkRecoveryHint(e.recoveryHint ?? null);
      })
      .finally(() => {
        setForkPreviewLoading(false);
      });
  };

  const closeFork = () => {
    setPendingFork(null);
    setForkPreview(null);
    setForkPreviewError(null);
    setForkRecoveryHint(null);
    setForkDialogError(null);
  };

  const runFork = async (options: { newInstruction?: string; newTitle?: string }) => {
    if (!pendingFork?.snapshot) return;
    setForkBusy(true);
    setForkDialogError(null);
    setForkRecoveryHint(null);
    try {
      const res = await data.forkMission(missionId, pendingFork.snapshot, options);
      const view = forkSuccessView(res, pendingFork.seq);
      closeFork();
      setToast({ tone: "ok", message: view.message });
      onSelectMission?.(res.newMissionId);
    } catch (err) {
      const e = classifyForkError(err);
      setForkDialogError(e.message);
      setForkRecoveryHint(e.recoveryHint ?? null);
    } finally {
      setForkBusy(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    setLoad({ state: "loading" });
    setLimit(TIMELINE_PAGE);
    data
      .getMissionTimeline(missionId)
      .then((events) => {
        if (mounted) setLoad({ state: "ready", steps: toTimelineSteps(events) });
      })
      .catch(() => {
        if (mounted) setLoad({ state: "error" });
      });
    return () => {
      mounted = false;
    };
  }, [data, missionId, attempt]);

  const empty = timelineEmptyState();
  const win = load.state === "ready" ? windowSteps(load.steps, limit) : { visible: [], hiddenCount: 0 };

  return (
    <section class="mission-timeline" aria-labelledby="missionTimelineHeading">
      <h2 class="mission-timeline-heading" id="missionTimelineHeading">Mission timeline</h2>
      {load.state === "loading" && (
        <p class="mission-timeline-note" role="status">Loading timeline…</p>
      )}
      {load.state === "error" && (
        <div class="mission-error" role="alert">
          <span>Could not load this mission's timeline.</span>
          <button type="button" class="btn-retry" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </div>
      )}
      {load.state === "ready" && load.steps.length === 0 && (
        <div class="mission-empty">
          <div class="mission-empty-title">{empty.title}</div>
          <div class="mission-empty-desc">{empty.desc}</div>
        </div>
      )}
      {load.state === "ready" && load.steps.length > 0 && (
        <>
          {win.hiddenCount > 0 && (
            <button
              type="button"
              class="btn-show-earlier"
              onClick={() => {
                setLimit((l) => nextLimit(l, load.steps.length));
                listRef.current?.focus();
              }}
            >
              Show earlier ({win.hiddenCount} more)
            </button>
          )}
          <ol class="timeline-steps" ref={listRef} tabIndex={0} aria-label="Mission steps, oldest first">
            {win.visible.map((s) => (
              <li key={s.key} class={`timeline-step timeline-${s.tone}`} data-step-kind={s.kind}>
                <span class="timeline-kind">{s.kindLabel}</span>
                <span class="timeline-summary">{s.summary}</span>
                <time class="timeline-time" dateTime={s.ts}>{formatStepTime(s.ts)}</time>
                {s.snapshot && (
                  <div class="timeline-step-actions">
                    <button
                      type="button"
                      class="btn-restore-step"
                      aria-label={`Restore to this step: ${s.kindLabel}, ${s.summary}`}
                      onClick={() => openRestore(s)}
                    >
                      Restore to this step
                    </button>
                    <button
                      type="button"
                      class="btn-fork-step"
                      aria-label={`Fork from this step: ${s.kindLabel}, ${s.summary}`}
                      onClick={() => openFork(s)}
                    >
                      Fork from this step
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {toast && (
        <div class={`restore-toast restore-toast-${toast.tone}`} role={toast.tone === "bad" ? "alert" : "status"}>
          <span>{toast.message}</span>
          {toast.undo && (
            <button type="button" class="btn-restore-undo" disabled={busy} onClick={() => runRestore(toast.undo!, true)}>Undo</button>
          )}
          <button type="button" class="btn-restore-dismiss" aria-label="Dismiss" onClick={() => setToast(null)}>×</button>
        </div>
      )}
      {pending && pending.snapshot && (
        <RestoreDialog
          step={pending}
          preview={preview}
          loading={previewLoading}
          busy={busy}
          error={previewError || dialogError}
          onConfirm={() => runRestore(pending.snapshot!, false)}
          onCancel={closeRestore}
        />
      )}
      {pendingFork && pendingFork.snapshot && (
        <ForkDialog
          step={pendingFork}
          preview={forkPreview}
          loading={forkPreviewLoading}
          busy={forkBusy}
          error={forkPreviewError || forkDialogError}
          recoveryHint={forkRecoveryHint}
          onConfirm={runFork}
          onCancel={closeFork}
        />
      )}
    </section>
  );
}
