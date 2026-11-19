/**
 * Phase 7 mesh judge (docs/design/phase7-mesh-tournament.md §5).
 *
 * Three stages over the finished attempts of a tournament round:
 *  - Stage 0: a deterministic eligibility gate (harness code, no model).
 *  - Stage 1: a deterministic rank when the gate leaves a winner.
 *  - Stage 2: a tie-break by the cross-family reviewer, validated so a bad or
 *    dishonest reviewer output falls back to Stage 1's order.
 *
 * The judge is a pure function: it returns the `mesh.decision` object and never
 * writes it. The tournament runner (S4) owns appending the decision to the
 * mission log, which is what makes replay (§6.3) and the write-once rule hold.
 */

import { createHash } from "node:crypto";
import type { MeshAttemptResultData } from "./types.js";

/** Everything the judge may know about one attempt. */
export interface JudgeAttempt {
  /** Attempt number; also the attempt id used in the decision and reviewer order. */
  n: number;
  /** The `mesh.attempt.result` data for this attempt. */
  result: MeshAttemptResultData;
  /** The attempt's diff, shown to the reviewer only for tied attempts. */
  diff?: string;
  /** The mission check's output, shown to the reviewer only for tied attempts. */
  checkOutput?: string;
}

/** Why Stage 0 rejected an attempt (§5.1). Names are ours; the doc fixes only the conditions. */
export type Stage0RejectionReason =
  | "check-not-run"
  | "check-failed"
  | "containment-events"
  | "scope-violations"
  | "no-change"
  | "diff-too-large"
  | "interrupted";

export interface RejectedAttempt {
  n: number;
  reason: Stage0RejectionReason;
}

export type TieBreak = "deterministic" | "reviewer" | "fallback-deterministic";

/** The `mesh.decision` record payload (§5.3). */
export interface MeshDecision {
  inputsHash: string;
  /** Ids of the attempts that passed Stage 0. */
  eligible: number[];
  /** Every Stage 0 rejection, for the receipt (§5.1: each attempt's reason). */
  rejected: RejectedAttempt[];
  /** Ids inside the tie band of the best attempt (always contains the best). */
  band: number[];
  /** The reviewer's raw output, recorded whenever the reviewer was called. */
  reviewerRaw?: string;
  /** Final ranking of eligible attempts, best first. Empty when none is eligible. */
  order: number[];
  /** Winner, or null when no attempt is eligible (tournament ends failed). */
  winner: number | null;
  tieBreak: TieBreak;
}

export interface JudgeOptions {
  /** Stage 0 cap on the diff size, default 1000 (§5.1 item 4). */
  maxDiffLines?: number;
  /**
   * The cross-family reviewer (§2.4, §5.3). It receives only the tied attempts
   * (their diffs and check output, no other attempt's information) and returns
   * its raw output as text; the judge parses and validates it, so the caller
   * never has to trust the model.
   */
  review?: (tied: JudgeAttempt[]) => Promise<string> | string;
}

const DEFAULT_MAX_DIFF_LINES = 1000;
/** Band: diffLines within 10% + 20 lines of the best (§5.3). */
const BAND_DIFF_MARGIN_RATIO = 1.1;
const BAND_DIFF_MARGIN_LINES = 20;
const BAND_COST_RATIO = 1.1;

/**
 * Stage 0 item 1, as its own predicate so the mutation probe has one spot to
 * flip: scripts/mesh-judge-probe.sh negates exactly this comparison.
 */
function isCheckPassed(checkExit: number | undefined): boolean {
  return checkExit === 0;
}

function stage0Rejection(a: JudgeAttempt, maxDiffLines: number): Stage0RejectionReason | null {
  const r = a.result;
  if (r.checkExit === undefined) return "check-not-run";
  if (!isCheckPassed(r.checkExit)) return "check-failed";
  if ((r.containmentEvents ?? 0) !== 0) return "containment-events";
  if ((r.scopeViolations ?? 0) !== 0) return "scope-violations";
  if ((r.diffLines ?? 0) <= 0) return "no-change";
  if ((r.diffLines ?? 0) > maxDiffLines) return "diff-too-large";
  if (r.outcome === "interrupted") return "interrupted";
  return null;
}

/** Stage 1: sort key `(diffLines asc, costUsd asc null last, wallMs asc, n asc)`. */
function rankAttempts(eligible: JudgeAttempt[]): JudgeAttempt[] {
  const cost = (a: JudgeAttempt): number | null => a.result.costUsd ?? null;
  return [...eligible].sort((a, b) => {
    const diff = (a.result.diffLines ?? 0) - (b.result.diffLines ?? 0);
    if (diff !== 0) return diff;
    const ca = cost(a);
    const cb = cost(b);
    if (ca === null || cb === null) {
      if (ca !== cb) return ca === null ? 1 : -1; // null cost sorts last
    } else if (ca !== cb) {
      return ca - cb;
    }
    const wall = (a.result.wallMs ?? 0) - (b.result.wallMs ?? 0);
    if (wall !== 0) return wall;
    return a.n - b.n;
  });
}

function inBand(a: JudgeAttempt, best: JudgeAttempt): boolean {
  const diffLines = a.result.diffLines ?? 0;
  const bestDiff = best.result.diffLines ?? 0;
  if (diffLines > bestDiff * BAND_DIFF_MARGIN_RATIO + BAND_DIFF_MARGIN_LINES) return false;
  const cost = a.result.costUsd ?? null;
  const bestCost = best.result.costUsd ?? null;
  if (cost === null) return bestCost === null; // unknown cost is never inside a priced band
  return bestCost !== null && cost <= bestCost * BAND_COST_RATIO;
}

/** The reviewer must return `{order: [...], reason}` with `order` a permutation of the tied set. */
function parseReviewerOrder(
  raw: string,
  tiedIds: number[],
): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // invalid JSON
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const order = (parsed as { order?: unknown }).order;
  if (!Array.isArray(order)) return null;
  const ids = order.map((id) => {
    // Attempt ids travel as JSON numbers; a stringed number is accepted so a
    // reviewer that quotes ids still validates.
    if (typeof id === "string" && /^\d+$/.test(id)) return Number(id);
    return typeof id === "number" ? id : NaN;
  });
  if (ids.some((id) => !Number.isInteger(id))) return null;
  const expected = new Set(tiedIds);
  if (ids.length !== tiedIds.length) return null;
  const seen = new Set<number>();
  for (const id of ids) {
    if (!expected.has(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return ids;
}

function inputsHash(attempts: JudgeAttempt[], maxDiffLines: number): string {
  const canonical = JSON.stringify({
    maxDiffLines,
    attempts: attempts.map((a) => ({ n: a.n, result: a.result })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Judge the round and return the decision. Never calls a model unless two or
 * more eligible attempts are inside the band of the best one (§5.3).
 */
export async function judgeAttempts(
  attempts: JudgeAttempt[],
  options: JudgeOptions = {},
): Promise<MeshDecision> {
  const maxDiffLines = options.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES;
  const base: MeshDecision = {
    inputsHash: inputsHash(attempts, maxDiffLines),
    eligible: [],
    rejected: [],
    band: [],
    order: [],
    winner: null,
    tieBreak: "deterministic",
  };

  const eligible: JudgeAttempt[] = [];
  for (const a of attempts) {
    const reason = stage0Rejection(a, maxDiffLines);
    if (reason === null) eligible.push(a);
    else base.rejected.push({ n: a.n, reason });
  }
  base.eligible = eligible.map((a) => a.n);

  const ranked = rankAttempts(eligible);
  if (ranked.length === 0) return base; // tournament ends failed; no model call (§5.1)
  base.order = ranked.map((a) => a.n);
  base.winner = ranked[0].n;

  const best = ranked[0];
  const band = ranked.filter((a) => inBand(a, best));
  base.band = band.map((a) => a.n);
  if (band.length <= 1) return base; // alone in the band: no model call (§5.3)

  let raw: string;
  try {
    raw = await options.review?.(band) ?? "";
  } catch {
    raw = ""; // a call error falls back like any other invalid output
  }
  base.reviewerRaw = raw;
  const reviewerOrder = parseReviewerOrder(raw, base.band);
  if (reviewerOrder === null) {
    base.tieBreak = "fallback-deterministic";
    return base; // Stage 1's order stands
  }
  // Reorder only the tied block inside Stage 1's ranking; the reviewer cannot
  // touch attempts outside the band because only those ids validate.
  const tiedSet = new Set(base.band);  const reordered: number[] = [];
  for (const n of base.order) {
    if (tiedSet.has(n)) continue;
    reordered.push(n);
  }
  base.order = [...reviewerOrder, ...reordered];
  base.winner = reviewerOrder[0];
  base.tieBreak = "reviewer";
  return base;
}
