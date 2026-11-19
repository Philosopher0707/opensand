/**
 * Phase 7 tournament limits (docs/design/phase7-mesh-tournament.md §6.1).
 *
 * Defaults and hard caps live here so every caller is refused the same way:
 * a value over its hard cap makes `startTournament` throw, never silently
 * clamp — a silently raised cap would spend money the operator did not
 * authorize.
 */

export interface TournamentLimits {
  /** Attempts per tournament: default 3, hard cap 5. */
  attempts: number;
  /** Concurrent attempts: default 2, hard cap 3. */
  concurrency: number;
  /** Mission budget in USD; attempts are refused past it (reservation before each call). */
  missionBudgetUsd?: number;
  /** Wall clock per attempt: default 20 min, hard cap 60 min. */
  perAttemptWallClockMs: number;
  /** Wall clock for the whole tournament: default 40 min, hard cap 4 h. */
  missionWallClockMs: number;
  /** Escalations per attempt: default 2, hard cap 2 (rung 0 → 2). */
  maxEscalations: number;
  /** Retries on `infra_error`, backoff 1 s / 4 s / 16 s, same rung: default 3, hard cap 3. */
  infraRetries: number;
  /** Backoff between infra retries, in ms; index `i` is the wait after retry `i` failed. */
  infraBackoffMs: number[];
  /** Diff size per attempt (Stage 0): default 1000 lines, hard cap 1000. */
  maxDiffLines: number;
  /** Reservation basis per model call: maxTokens × the model's output price. */
  maxTokensPerCall: number;
}

export const DEFAULT_LIMITS: TournamentLimits = {
  attempts: 3,
  concurrency: 2,
  perAttemptWallClockMs: 20 * 60_000,
  missionWallClockMs: 40 * 60_000,
  maxEscalations: 2,
  infraRetries: 3,
  infraBackoffMs: [1_000, 4_000, 16_000],
  maxDiffLines: 1000,
  maxTokensPerCall: 8192,
};

/** Hard caps from §6.1. `maxDiffLines` has no larger cap: Stage 0 is the cap. */
export const HARD_CAPS = {
  attempts: 5,
  concurrency: 3,
  perAttemptWallClockMs: 60 * 60_000,
  missionWallClockMs: 4 * 60 * 60_000,
  maxEscalations: 2,
  infraRetries: 3,
  maxDiffLines: 1000,
} as const;

const HARD_CAP_KEYS = new Set([
  "attempts",
  "concurrency",
  "perAttemptWallClockMs",
  "missionWallClockMs",
  "maxEscalations",
  "infraRetries",
  "maxDiffLines",
]);

/**
 * Merge a partial override onto the defaults, refusing anything over its hard
 * cap with the limit named. Fields without a hard cap (budgets, backoffs,
 * token counts) accept any finite non-negative value.
 */
export function resolveTournamentLimits(partial: Partial<TournamentLimits> = {}): TournamentLimits {
  const merged: TournamentLimits = { ...DEFAULT_LIMITS, ...partial };
  for (const key of HARD_CAP_KEYS) {
    const value = merged[key as keyof TournamentLimits] as number | undefined;
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`mesh limits: ${key} must be a finite non-negative number`);
    }
    const cap = HARD_CAPS[key as keyof typeof HARD_CAPS];
    if (value > cap) {
      throw new Error(`mesh limits: ${key}=${value} exceeds the hard cap ${cap}`);
    }
  }
  if (merged.infraBackoffMs.some((ms) => !Number.isFinite(ms) || ms < 0)) {
    throw new Error("mesh limits: infraBackoffMs entries must be finite non-negative numbers");
  }
  if (partial.missionBudgetUsd !== undefined && (partial.missionBudgetUsd < 0 || !Number.isFinite(partial.missionBudgetUsd))) {
    throw new Error("mesh limits: missionBudgetUsd must be a finite non-negative number");
  }
  return merged;
}
