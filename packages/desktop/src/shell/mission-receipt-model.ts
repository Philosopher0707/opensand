export interface RawReceiptEvent {
  seq: number;
  ts: string;
  kind: string;
  data?: Record<string, any>;
}

export interface ReceiptFile {
  /** Workspace-relative path; never an absolute or home path. */
  file: string;
  /** Line ranges as the design doc shows them, e.g. "46-171, 200". Empty for deletes and renames. */
  lines: string;
}

/** What crosses IPC: display fields only. No diffs, no output, no raw receipt object. */
export interface ReceiptView {
  status: "VERIFIED" | "FAILED" | "STOPPED";
  summary: string;
  checks: { total: number; failed: number; lastExitCode: number | null };
  changedAvailable: boolean;
  changedReason?: string;
  changed: ReceiptFile[];
  durationMs: number | null;
  notDone?: string;
}

const TERMINAL = new Set(["mission.verified", "mission.failed", "mission.stopped"]);
const TEXT_MAX = 300;
const MAX_FILES = 200;

function text(v: unknown, max = TEXT_MAX): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** Keeps a path relative: an absolute path (POSIX or Windows) shrinks to its last two segments. */
export function displayPath(p: string): string {
  const norm = p.replace(/\\/g, "/");
  if (/^([A-Za-z]:)?\//.test(norm) || norm.startsWith("~")) {
    const parts = norm.split("/").filter((s) => s && s !== "~" && !/^[A-Za-z]:$/.test(s));
    return "…/" + parts.slice(-2).join("/");
  }
  return norm;
}

function rangesText(ranges: unknown): string {
  if (!Array.isArray(ranges)) return "";
  return ranges
    .filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]))
    .map(([a, b]: [number, number]) => (a === b ? `${a}` : `${a}-${b}`))
    .join(", ");
}

/**
 * Event log → receipt for the display, or null while the mission has no receipt (still
 * running, or ended without one). The harness wrote the receipt; this only reshapes it.
 */
export function buildReceiptView(events: RawReceiptEvent[]): ReceiptView | null {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let terminal: RawReceiptEvent | undefined;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (TERMINAL.has(sorted[i].kind)) { terminal = sorted[i]; break; }
  }
  const r = terminal?.data?.receipt;
  if (!terminal || !r || typeof r !== "object") return null;

  const started = sorted.find((e) => e.kind === "mission.started");
  const t0 = started ? Date.parse(started.ts) : NaN;
  const t1 = Date.parse(terminal.ts);
  const durationMs = Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0 ? t1 - t0 : null;

  const ran = r.ran ?? {};
  const lastExit = ran.lastExitCode;
  const status = terminal.kind === "mission.stopped" ? "STOPPED" : r.status === "VERIFIED" ? "VERIFIED" : "FAILED";
  const changed: ReceiptFile[] = Array.isArray(r.changed)
    ? r.changed
        .filter((c: any) => c && typeof c.file === "string")
        .slice(0, MAX_FILES)
        .map((c: any) => ({ file: displayPath(c.file), lines: rangesText(c.ranges) || (Array.isArray(c.deletedAt) && c.deletedAt.length ? "(deleted)" : "(renamed)") }))
    : [];

  return {
    status,
    summary: text(r.summary) ?? "",
    checks: { total: count(ran.total), failed: count(ran.failed), lastExitCode: typeof lastExit === "number" ? lastExit : null },
    changedAvailable: r.changedAvailable !== false,
    changedReason: text(r.changedReason, 120),
    changed,
    durationMs,
    notDone: text(r.notDone),
  };
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatChecks(c: ReceiptView["checks"]): string {
  const runs = `${c.total} command${c.total === 1 ? "" : "s"}, ${c.failed} non-zero`;
  return c.lastExitCode === null ? runs : `${runs} (last exit ${c.lastExitCode})`;
}

export function formatChanged(v: ReceiptView): string {
  if (!v.changedAvailable) return `Not available${v.changedReason ? ` (${v.changedReason})` : ""}`;
  if (v.changed.length === 0) return "No files changed";
  return `${v.changed.length} file${v.changed.length === 1 ? "" : "s"}`;
}
