/**
 * Phase 7 start-rung routing (docs/design/phase7-mesh-tournament.md §2.3).
 *
 * Pure function. The ladder order is the user's `mesh/routes.json` order;
 * stats only skip rungs that have no qualifying record. Nothing is re-ordered
 * silently.
 */
import { type MeshStats, type StatsKey, statsKey } from "./stats.js";

export interface RungThresholds {
  minSamples: number;
  minPassRate: number;
}

export const DEFAULT_THRESHOLDS: RungThresholds = { minSamples: 5, minPassRate: 0.5 };

export type StartRungReason =
  | "qualifying-record"
  | "no-qualifying-record"
  | "timeout-window";

export interface StartRung {
  rung: number;
  model: string;
  reason: StartRungReason;
}

/**
 * A rung with 3 timeouts in its last 10 attempts is skipped until one of its
 * attempts succeeds: within the window, a success after the third timeout
 * lifts the skip; otherwise the rung is benched.
 */
function timeoutSkipped(stats: MeshStats): boolean {
  let timeouts = 0;
  for (let i = 0; i < stats.window.length; i++) {
    if (stats.window[i] === "timeout") {
      timeouts++;
      if (timeouts === 3) {
        return !stats.window.slice(i + 1).includes("passed");
      }
    }
  }
  return false;
}

/**
 * Walk the ladder in order and return the first rung whose stats for `role`
 * have `counted >= minSamples` and a Wilson lower bound (95%) of the pass
 * rate `>= minPassRate`, and that is not benched by the timeout window.
 * If none qualifies, the start is rung 0 with reason "no-qualifying-record".
 */
export function selectStartRung(
  role: string,
  ladder: string[],
  stats: Map<StatsKey, MeshStats>,
  // Reserved for recency handling; the fold's windows already bound staleness.
  _now: number = Date.now(),
  thresholds: RungThresholds = DEFAULT_THRESHOLDS,
): StartRung {
  if (ladder.length === 0) throw new Error(`mesh routing: empty ladder for role ${role}`);
  let timeoutFallback = false;
  for (let rung = 0; rung < ladder.length; rung++) {
    const model = ladder[rung]!;
    const modelStats = stats.get(statsKey(role, model));
    if (modelStats && timeoutSkipped(modelStats)) {
      timeoutFallback = true;
      continue;
    }
    if (
      modelStats &&
      modelStats.counted >= thresholds.minSamples &&
      modelStats.rateWilsonLow >= thresholds.minPassRate
    ) {
      return { rung, model, reason: "qualifying-record" };
    }
  }
  return {
    rung: 0,
    model: ladder[0]!,
    reason: timeoutFallback ? "timeout-window" : "no-qualifying-record",
  };
}
