import type { MissionStatus } from "@opensand/shared";

export type { MissionStatus };

export interface MissionSummary {
  missionId: string;
  title: string;
  status: MissionStatus | string;
  updatedAt: string;
}

export interface MissionRow {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  timeLabel: string;
  active: boolean;
}

export interface MissionEmptyState {
  title: string;
  desc: string;
}

const STATUS_LABELS: Record<string, string> = {
  planned: "Queued",
  running: "Running",
  "needs-you": "Waiting for you",
  verified: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? "Unknown";
}

function timeOf(iso: string | undefined): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Newest update first; undated missions last; ties broken by id so order is stable. */
export function sortMissions(missions: MissionSummary[]): MissionSummary[] {
  return [...missions].sort((a, b) => {
    const diff = timeOf(b.updatedAt) - timeOf(a.updatedAt);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
    return a.missionId.localeCompare(b.missionId);
  });
}

export function toMissionRow(
  summary: MissionSummary,
  timeLabel: string,
  activeId?: string | null
): MissionRow {
  return {
    id: summary.missionId,
    title: summary.title || summary.missionId || "Untitled mission",
    status: summary.status,
    statusLabel: statusLabel(summary.status),
    timeLabel,
    active: Boolean(activeId && summary.missionId === activeId),
  };
}

export function missionEmptyState(): MissionEmptyState {
  return {
    title: "No missions yet",
    desc: "Missions you start show up here with their status.",
  };
}

export type ListKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** Roving-focus index for a vertical list; clamps at both ends. */
export function nextIndex(current: number, key: string, length: number): number {
  if (length <= 0) return -1;
  const last = length - 1;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : Math.min(current + 1, last);
    case "ArrowUp":
      return current < 0 ? last : Math.max(current - 1, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return current;
  }
}
