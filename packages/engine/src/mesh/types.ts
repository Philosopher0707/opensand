/**
 * Phase 7 mesh types (docs/design/phase7-mesh-tournament.md §3.1).
 *
 * `mesh.attempt.result` is one record per finished attempt, appended to the
 * mission's hash-chained `log.jsonl`. Stats (mesh/stats.ts) are a rebuildable
 * projection over these records; nothing else is authoritative.
 */

/** Outcomes of a finished attempt. Counted for routing: passed, check_failed, no_change, review_rejected. */
export type AttemptOutcome =
  | "passed"
  | "check_failed"
  | "no_change"
  | "review_rejected"
  | "timeout"
  | "infra_error"
  | "interrupted"
  | "budget_stopped";

const COUNTED_OUTCOMES: ReadonlySet<AttemptOutcome> = new Set([
  "passed",
  "check_failed",
  "no_change",
  "review_rejected",
]);

export function isCountedOutcome(outcome: AttemptOutcome): boolean {
  return COUNTED_OUTCOMES.has(outcome);
}

/**
 * The `data` payload of a `mesh.attempt.result` record. Fields beyond
 * role/model/outcome/costUsd are documented in the design (§3.1) and are not
 * read by the fold; they belong to the receipt and the cost ledger.
 */
export interface MeshAttemptResultData {
  role: string;
  model: string;
  /** Model family from the catalog; "unknown" when the catalog has no entry. */
  family?: string;
  outcome: AttemptOutcome;
  /** Exit code of the mission check; omitted when the check never ran. */
  checkExit?: number;
  diffLines?: number;
  filesChanged?: number;
  /** Settled cost of the attempt in USD; null when no price is known. */
  costUsd?: number | null;
  wallMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Ladder position the attempt ran at. */
  rung?: number;
  /** When escalation moved the attempt up the ladder: the rung it left. */
  escalatedFrom?: string;
  missionBudgetUsd?: number;
  scopeViolations?: number;
  containmentEvents?: number;
}

export interface MeshAttemptResultRecord {
  seq: number;
  kind: "mesh.attempt.result";
  attempt: number;
  node: string;
  data: MeshAttemptResultData;
}

/** Any event-log record; the fold ignores everything but `mesh.attempt.result`. */
export type MeshLogRecord = MeshAttemptResultRecord | Record<string, unknown>;

export function isMeshAttemptResult(record: MeshLogRecord): record is MeshAttemptResultRecord {
  return (
    typeof record === "object" &&
    record !== null &&
    (record as { kind?: unknown }).kind === "mesh.attempt.result"
  );
}
