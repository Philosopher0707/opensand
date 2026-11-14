import { useState, useEffect } from "preact/hooks";
import type { ShellData } from "../data";
import { diffNote, type FileDiffView } from "../../../src/shell/mission-diff-model";

export interface MissionDiffProps {
  data: ShellData;
  missionId: string;
  fileIndex: number;
}

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; view: FileDiffView | null };

export function MissionDiff({ data, missionId, fileIndex }: MissionDiffProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoad({ state: "loading" });
    data
      .getMissionFileDiff(missionId, fileIndex)
      .then((view) => {
        if (mounted) setLoad({ state: "ready", view });
      })
      .catch(() => {
        if (mounted) setLoad({ state: "error" });
      });
    return () => {
      mounted = false;
    };
  }, [data, missionId, fileIndex, attempt]);

  if (load.state === "loading") return <p class="diff-note" role="status">Loading changes…</p>;
  if (load.state === "error") {
    return (
      <div class="mission-error diff-error" role="alert">
        <span>Could not load the changes.</span>
        <button type="button" class="btn-retry" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
      </div>
    );
  }
  const view: FileDiffView = load.view ?? { state: "unavailable", file: "" };
  const note = diffNote(view);
  if (note) return <p class="diff-note" data-diff-state={view.state}>{note}</p>;
  if (view.state !== "ready") return null;
  return (
    <div class="mission-diff" data-diff-state="ready" tabIndex={0} role="region" aria-label={`Changes in ${view.file}`}>
      {view.hunks.map((h, i) => (
        <div class="diff-hunk" key={i}>
          <div class="diff-hunk-header">{h.header}</div>
          {h.lines.map((l, j) => (
            <div class={`diff-line diff-${l.kind}`} key={j}>
              <span class="diff-sign" aria-hidden="true">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
              <span class="diff-text">{l.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
