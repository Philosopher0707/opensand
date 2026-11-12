export interface SessionSummary {
  id: string;
  title?: string;
  messageCount?: number;
  createdAt?: string;
  updatedAt?: string;
  agentId?: string;
  roomId?: string;
}

export interface SessionRow {
  id: string;
  title: string;
  timeLabel: string;
  snippet: string;
  avatar: string;
  active: boolean;
}

export interface EmptyStateInfo {
  title: string;
  desc: string;
}

export const RELATIVE_UNITS = [
  { limit: 60_000, divisor: 1_000, unit: "second" },
  { limit: 3_600_000, divisor: 60_000, unit: "minute" },
  { limit: 86_400_000, divisor: 3_600_000, unit: "hour" },
  { limit: 604_800_000, divisor: 86_400_000, unit: "day" },
  { limit: Number.POSITIVE_INFINITY, divisor: 604_800_000, unit: "week" },
] as const;

const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function relativeTime(iso: string | undefined | null, now: number): string {
  if (!iso) return "";
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  const elapsed = now - time;
  const scale = RELATIVE_UNITS.find(({ limit }) => Math.abs(elapsed) < limit) || RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  return relativeFormat.format(-Math.round(elapsed / scale.divisor), scale.unit);
}

export function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const q = query ? query.trim().toLowerCase() : "";
  if (!q) return sessions;
  return sessions.filter((s) => (s.title || s.id || "").toLowerCase().includes(q));
}

export function toRow(summary: SessionSummary, now: number, activeId?: string | null): SessionRow {
  const title = summary.title || summary.id || "New conversation";
  const timeStr = relativeTime(summary.updatedAt || summary.createdAt, now);
  const count = summary.messageCount;
  const snippet = count ? `${count} ${count === 1 ? "message" : "messages"}` : "New conversation";
  const trimmed = title.trim();
  const avatar = (trimmed[0] || "?").toUpperCase();
  const active = Boolean(activeId && summary.id === activeId);

  return {
    id: summary.id,
    title,
    timeLabel: timeStr,
    snippet,
    avatar,
    active,
  };
}

export function emptyState(query: string): EmptyStateInfo | null {
  const q = query ? query.trim() : "";
  if (q) {
    return {
      title: "No conversations match",
      desc: `No conversation has “${q}” in its name.`,
    };
  }
  return {
    title: "No conversations yet",
    desc: "Start a conversation with a Bot and it shows up here.",
  };
}
