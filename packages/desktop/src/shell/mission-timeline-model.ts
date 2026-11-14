export interface RawTimelineEvent {
  seq: number;
  ts: string;
  kind: string;
  data: Record<string, any>;
}

export type StepKind = "start" | "plan" | "act" | "tool" | "check" | "review" | "repair" | "waiting" | "answered" | "receipt" | "end";

export interface TimelineStep {
  key: string;
  kind: StepKind;
  kindLabel: string;
  summary: string;
  ts: string;
  tone: "neutral" | "ok" | "bad" | "attention";
}

export const TIMELINE_PAGE = 200;

const KIND_LABELS: Record<StepKind, string> = {
  start: "Start",
  plan: "Plan",
  act: "Work",
  tool: "Tool",
  check: "Check",
  review: "Review",
  repair: "Repair",
  waiting: "Waiting for you",
  answered: "You answered",
  receipt: "Receipt",
  end: "End",
};

function step(ev: RawTimelineEvent, kind: StepKind, summary: string, tone: TimelineStep["tone"] = "neutral"): TimelineStep {
  return { key: `${ev.seq}-${ev.kind}`, kind, kindLabel: KIND_LABELS[kind], summary, ts: ev.ts, tone };
}

function oneLine(text: unknown, max = 140): string {
  const s = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function seconds(ms: unknown): string {
  return typeof ms === "number" && Number.isFinite(ms) ? ` (${(ms / 1000).toFixed(1)}s)` : "";
}

const NODE_KINDS: Record<string, StepKind> = { plan: "plan", act: "act", repair: "repair", receipt: "receipt" };

/**
 * Event log → timeline steps, oldest first. Shapes are the engine's (runner.ts): node.started
 * is skipped (its node.completed, check.completed or review.completed carries the result);
 * kinds the engine does not record for a mission are dropped, never guessed at.
 */
export function toTimelineSteps(events: RawTimelineEvent[]): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const ev of sorted) {
    const d = ev.data ?? {};
    switch (ev.kind) {
      case "mission.started":
        steps.push(step(ev, "start", oneLine(d.title) || "Mission started"));
        break;
      case "node.completed": {
        const kind = NODE_KINDS[String(d.node)];
        if (!kind) break;
        const base = kind === "act" && d.claim ? oneLine(d.claim) : `${KIND_LABELS[kind]} finished`;
        steps.push(step(ev, kind, base + seconds(d.durationMs)));
        break;
      }
      case "tool.completed":
      case "tool.failed":
        steps.push(step(ev, "tool", oneLine(d.tool ?? d.name) || "Tool call", ev.kind === "tool.failed" ? "bad" : "neutral"));
        break;
      case "check.completed": {
        const ok = d.passed === true;
        const code = d.exitCode === null || d.exitCode === undefined ? "" : ` (exit ${d.exitCode})`;
        steps.push(step(ev, "check", (ok ? "Check passed" : "Check failed") + code, ok ? "ok" : "bad"));
        break;
      }
      case "review.completed":
        steps.push(step(ev, "review", (d.accept ? "Accepted" : "Changes requested") + (d.note ? `: ${oneLine(d.note, 100)}` : ""), d.accept ? "ok" : "bad"));
        break;
      case "mission.needs-you":
        steps.push(step(ev, "waiting", d.question === "folder-trust" && d.folder ? `Trust this folder? ${oneLine(d.folder, 100)}` : "Needs your answer", "attention"));
        break;
      case "mission.answered":
        steps.push(step(ev, "answered", d.level ? `Answered: ${d.level}` : "Answered"));
        break;
      case "mission.verified":
        steps.push(step(ev, "end", "Verified", "ok"));
        break;
      case "mission.failed":
        steps.push(step(ev, "end", "Failed" + (d.error ? `: ${oneLine(d.error, 100)}` : ""), "bad"));
        break;
      case "mission.stopped":
        steps.push(step(ev, "end", "Stopped" + (d.reason ? `: ${oneLine(d.reason, 60)}` : ""), "attention"));
        break;
      default:
        break;
    }
  }
  return steps;
}

export interface TimelineWindow {
  visible: TimelineStep[];
  hiddenCount: number;
}

/** Newest `limit` steps (still oldest first); `hiddenCount` older ones are behind "show earlier". */
export function windowSteps(steps: TimelineStep[], limit = TIMELINE_PAGE): TimelineWindow {
  const n = Math.max(0, Math.floor(limit));
  const hiddenCount = Math.max(0, steps.length - n);
  return { visible: hiddenCount ? steps.slice(hiddenCount) : steps, hiddenCount };
}

export function nextLimit(limit: number, total: number, page = TIMELINE_PAGE): number {
  return Math.min(total, limit + page);
}

export function timelineEmptyState(): { title: string; desc: string } {
  return { title: "No steps recorded", desc: "This mission has no events yet." };
}

/** Local wall-clock time, 24h; `timeZone` is for tests. */
export function formatStepTime(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone });
}
