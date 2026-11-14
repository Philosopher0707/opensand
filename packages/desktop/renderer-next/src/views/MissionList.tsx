import { useState, useEffect, useRef } from "preact/hooks";
import type { ShellData, MissionSummary } from "../data";
import { relativeTime } from "../../../src/shell/session-list-model";
import {
  sortMissions,
  toMissionRow,
  missionEmptyState,
  nextIndex,
  type MissionRow,
} from "../../../src/shell/mission-list-model";

export interface MissionListProps {
  data: ShellData;
  now?: () => number;
  onSelect?: (missionId: string) => void;
}

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; missions: MissionSummary[] };

export function MissionList({ data, now, onSelect }: MissionListProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    setLoad({ state: "loading" });
    data
      .listMissions()
      .then((res) => {
        if (mounted) setLoad({ state: "ready", missions: Array.isArray(res) ? res : [] });
      })
      .catch(() => {
        if (mounted) setLoad({ state: "error" });
      });
    return () => {
      mounted = false;
    };
  }, [data, attempt]);

  const currentTime = now ? now() : Date.now();
  const rows: MissionRow[] =
    load.state === "ready"
      ? sortMissions(load.missions).map((m) => toMissionRow(m, relativeTime(m.updatedAt, currentTime), activeId))
      : [];

  const select = (id: string) => {
    setActiveId(id);
    onSelect?.(id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      const row = rows[focusIdx];
      if (row) {
        e.preventDefault();
        select(row.id);
      }
      return;
    }
    const next = nextIndex(focusIdx, e.key, rows.length);
    if (next !== focusIdx || ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      setFocusIdx(next);
      (listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[next])?.focus();
    }
  };

  const empty = missionEmptyState();

  return (
    <>
      <h2 class="mission-list-heading" id="missionListHeading">Missions</h2>
      {load.state === "loading" && (
        <div class="mission-empty" role="status">
          <div class="mission-empty-desc">Loading missions…</div>
        </div>
      )}
      {load.state === "error" && (
        <div class="mission-error" role="alert">
          <span>Could not load missions.</span>
          <button type="button" class="btn-retry" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </div>
      )}
      {load.state === "ready" && rows.length === 0 && (
        <div class="mission-empty">
          <div class="mission-empty-title">{empty.title}</div>
          <div class="mission-empty-desc">{empty.desc}</div>
        </div>
      )}
      {load.state === "ready" && rows.length > 0 && (
        <div role="listbox" aria-labelledby="missionListHeading" ref={listRef} onKeyDown={onKeyDown}>
          {rows.map((row, i) => (
            <div
              key={row.id}
              role="option"
              aria-selected={row.active}
              tabIndex={i === focusIdx ? 0 : -1}
              class={`mission-item ${row.active ? "active" : ""}`}
              data-mission-id={row.id}
              onClick={() => {
                setFocusIdx(i);
                select(row.id);
              }}
              onFocus={() => setFocusIdx(i)}
            >
              <span class="mission-title" title={row.title}>{row.title}</span>
              <span class="mission-meta">
                <span class={`mission-status mission-status-${row.status}`}>{row.statusLabel}</span>
                <span class="mission-time">{row.timeLabel}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
