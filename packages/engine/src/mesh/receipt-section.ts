/**
 * Phase 7 Tournament receipt section (docs/design/phase7-mesh-tournament.md §3.4).
 *
 * Built from the mission log's records — the model never writes this; the
 * harness projects it, the same rule the §4.3 conversation projection applies.
 * One receipt row per `mesh.attempt.result` record, in log order, so the rows
 * match the log records one-to-one.
 */
import type { SessionEvent } from "@opensand/shared";
import type { AttemptOutcome, MeshAttemptResultData } from "./types.js";
import type { MeshDecision } from "./judge.js";

export interface TournamentSectionRow {
  attempt: number;
  outcome: AttemptOutcome;
  model: string;
  diffLines?: number;
  costUsd?: number | null;
  wallMs?: number;
  /** Ladder position the attempt ran at (§3.1). */
  rung?: number;
  /** When escalation moved the attempt up the ladder: the rung it left. */
  escalatedFrom?: string;
  /** True for the attempt the judge kept. */
  kept: boolean;
  /** The kept attempt's branch name (`opensand/<mission>/<n>`). */
  keptBranch?: string;
}

export interface TournamentSection {
  /** The mission the section was projected from; names the loser snapshot refs. */
  missionId: string;
  base: string;
  attempts: number;
  concurrency: number;
  rows: TournamentSectionRow[];
  judge?: MeshDecision;
  routing?: {
    role: string;
    rung: number;
    model: string;
    reason: string;
  };
}

interface StartedData {
  base?: string;
  attempts?: number;
  concurrency?: number;
  role?: string;
}

/**
 * Project the Tournament section from a mission log's events. Undefined when
 * the log has no `mesh.tournament.started` record (an ordinary Phase 3
 * mission has no Tournament section).
 */
export function buildTournamentSection(events: SessionEvent[]): TournamentSection | undefined {
  const started = [...events].reverse().find((e) => e.kind === "mesh.tournament.started");
  if (!started) return undefined;
  const startedData = (started.data ?? {}) as StartedData;
  const missionId = started.sessionId ?? "";

  const results = events
    .filter((e) => e.kind === "mesh.attempt.result")
    .map((e) => e as unknown as { data: MeshAttemptResultData; attempt?: number });

  const finished = [...events]
    .reverse()
    .find((e) => e.kind === "mesh.tournament.finished");
  const finishedData = (finished?.data ?? {}) as { winner?: number | null; keptBranch?: string | null };
  const decision = [...events]
    .reverse()
    .find((e) => e.kind === "mesh.decision")?.data as MeshDecision | undefined;
  const route = [...events].reverse().find((e) => e.kind === "mesh.route.selected")?.data as
    | { role: string; rung: number; model: string; reason: string }
    | undefined;

  const rows: TournamentSectionRow[] = results.map((r, i) => ({
    attempt: r.attempt ?? i + 1,
    outcome: r.data.outcome,
    model: r.data.model,
    diffLines: r.data.diffLines,
    costUsd: r.data.costUsd,
    wallMs: r.data.wallMs,
    rung: r.data.rung,
    escalatedFrom: r.data.escalatedFrom,
    kept: finishedData.winner === (r.attempt ?? i + 1),
    keptBranch: finishedData.winner === (r.attempt ?? i + 1) ? (finishedData.keptBranch ?? undefined) : undefined,
  }));

  return {
    missionId,
    base: startedData.base ?? "unknown",
    attempts: startedData.attempts ?? rows.length,
    concurrency: startedData.concurrency ?? 1,
    rows,
    judge: decision,
    routing: route
      ? { role: route.role, rung: route.rung, model: route.model, reason: route.reason }
      : undefined,
  };
}

function formatCost(costUsd?: number | null): string {
  if (costUsd === null || costUsd === undefined) return "  —  ";
  return `$${costUsd.toFixed(2)}`;
}

function formatWall(wallMs?: number): string {
  if (wallMs === undefined) return "—";
  const minutes = Math.floor(wallMs / 60_000);
  const seconds = Math.floor((wallMs % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function judgeLine(section: TournamentSection): string | null {
  const d = section.judge;
  if (!d) return null;
  const passedCount = d.eligible.length;
  let line: string;
  if (d.tieBreak === "reviewer") {
    line = `Judge: cross-family reviewer decided (${passedCount} passed)`;
  } else if (d.tieBreak === "fallback-deterministic") {
    line = `Judge: reviewer output invalid, fell back to deterministic (${passedCount} passed)`;
  } else {
    line = `Judge: deterministic (${passedCount} passed). No tie-break.`;
  }
  const losers = section.rows
    .filter((r) => !r.kept)
    .map((r) => `#${r.attempt} refs/opensand/missions/${section.missionId}/attempts/${r.attempt}`);
  if (losers.length > 0) line += ` Losers snapshotted: ${losers.join(", ")}`;
  return line;
}

function routingLine(section: TournamentSection): string | null {
  const r = section.routing;
  if (!r) return null;
  let line = `Routing: ${r.role} start ${r.model} (${r.reason})`;
  // An attempt above the start rung moved up the ladder; the outcome that
  // triggered it is the previous attempt's outcome (the one that failed at
  // the lower rung).
  const escalated = section.rows.find((row) => (row.rung ?? 0) > r.rung && row.escalatedFrom !== undefined);
  if (escalated) {
    const prev = section.rows.find((row) => row.attempt === escalated.attempt - 1);
    line += `; escalated to rung ${escalated.rung}${prev ? ` on ${prev.outcome}` : ""}`;
  }
  return line;
}

/** Render the section as receipt lines, in the §3.4 shape. */
export function renderTournamentSection(section: TournamentSection): string[] {
  const lines: string[] = [];
  lines.push(
    `Tournament  ${section.attempts} attempts, ${section.concurrency} concurrent · base ${shortSha(section.base)}`,
  );
  for (const row of section.rows) {
    const kept = row.kept ? `  ← kept${row.keptBranch ? ` (branch ${row.keptBranch})` : ""}` : "";
    lines.push(
      `  #${row.attempt}  ${row.outcome.padEnd(14)} ${row.model.padEnd(30)} diff ${row.diffLines ?? 0}` +
        `   ${formatCost(row.costUsd)}   ${formatWall(row.wallMs)}${kept}`,
    );
  }
  const judge = judgeLine(section);
  if (judge) lines.push(`  ${judge}`);
  const routing = routingLine(section);
  if (routing) lines.push(`  ${routing}`);
  return lines;
}
