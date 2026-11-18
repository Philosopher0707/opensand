/**
 * Phase 7 mesh stats fold (docs/design/phase7-mesh-tournament.md §3.2).
 *
 * Pure function over log records. Per (role, model) it keeps the last 50
 * counted results and the last 10 attempts (all outcomes), and reports the
 * Wilson lower bound (95%, z = 1.96) of the pass rate over the counted window.
 * Only a model's own outcomes count; infra outcomes are logged but never move
 * a pass rate (§3.1).
 */
import {
  type AttemptOutcome,
  type MeshAttemptResultRecord,
  type MeshLogRecord,
  isCountedOutcome,
  isMeshAttemptResult,
} from "./types.js";

/** Wilson lower bound (95%, z = 1.96) of a pass rate; 0 when there are no samples. */
export function wilsonLowerBound(passed: number, counted: number, z = 1.96): number {
  if (counted <= 0) return 0;
  const p = passed / counted;
  const centre = p + (z * z) / (2 * counted);
  const spread = z * Math.sqrt((p * (1 - p)) / counted + (z * z) / (4 * counted * counted));
  return (centre - spread) / (1 + (z * z) / counted);
}

export interface MeshStats {
  /** Model's own outcomes in the counted window. */
  counted: number;
  passed: number;
  rateWilsonLow: number;
  /** Median settled cost over the counted window; null when no cost was recorded. */
  costMedianUsd: number | null;
  /** Timeouts among the last 10 attempts. */
  timeouts: number;
  /** Last 10 attempt outcomes in chronological order (timeout-window rule, §2.3 step 4). */
  window: AttemptOutcome[];
}

export interface CountedStats extends MeshStats {
  countedOutcomes: AttemptOutcome[];
  countedCosts: number[];
}

export type StatsKey = string;

/** Collision-proof key for a (role, model) pair; NUL cannot appear in either. */
export function statsKey(role: string, model: string): StatsKey {
  return `${role}\u0000${model}`;
}

const COUNTED_WINDOW = 50;
const ATTEMPT_WINDOW = 10;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function emptyStats(): CountedStats {
  return {
    counted: 0,
    passed: 0,
    rateWilsonLow: 0,
    costMedianUsd: null,
    timeouts: 0,
    window: [],
    countedOutcomes: [],
    countedCosts: [],
  };
}

function finalize(stats: CountedStats): MeshStats {
  const { countedOutcomes, countedCosts, ...rest } = stats;
  return {
    ...rest,
    rateWilsonLow: wilsonLowerBound(stats.passed, stats.counted),
    costMedianUsd: median(countedCosts),
  };
}

/**
 * Fold `mesh.attempt.result` records (in log order) into per-(role, model)
 * stats. Unknown record kinds are ignored, so callers can pass a whole log.
 */
export function foldMeshStats(records: MeshLogRecord[]): Map<StatsKey, MeshStats> {
  const byKey = new Map<StatsKey, CountedStats>();
  for (const record of records) {
    if (!isMeshAttemptResult(record)) continue;
    const { role, model, outcome, costUsd } = record.data;
    const key = statsKey(role, model);
    let stats = byKey.get(key);
    if (!stats) {
      stats = emptyStats();
      byKey.set(key, stats);
    }
    stats.window.push(outcome);
    if (stats.window.length > ATTEMPT_WINDOW) stats.window.shift();
    stats.timeouts = stats.window.filter((o) => o === "timeout").length;
    if (isCountedOutcome(outcome)) {
      stats.countedOutcomes.push(outcome);
      if (stats.countedOutcomes.length > COUNTED_WINDOW) stats.countedOutcomes.shift();
      if (typeof costUsd === "number") {
        stats.countedCosts.push(costUsd);
        if (stats.countedCosts.length > COUNTED_WINDOW) stats.countedCosts.shift();
      }
      stats.counted = stats.countedOutcomes.length;
      stats.passed = stats.countedOutcomes.filter((o) => o === "passed").length;
    }
  }
  const out = new Map<StatsKey, MeshStats>();
  for (const [key, stats] of byKey) out.set(key, finalize(stats));
  return out;
}
