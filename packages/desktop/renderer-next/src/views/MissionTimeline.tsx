import { useState, useEffect, useRef } from "preact/hooks";
import type { ShellData } from "../data";
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
}

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; steps: TimelineStep[] };

export function MissionTimeline({ data, missionId }: MissionTimelineProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [limit, setLimit] = useState(TIMELINE_PAGE);
  const [attempt, setAttempt] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);

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
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
