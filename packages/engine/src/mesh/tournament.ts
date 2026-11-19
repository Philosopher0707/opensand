/**
 * Phase 7 tournament runner (docs/design/phase7-mesh-tournament.md §10 S4).
 *
 * `startTournament` drives the attempt state machine over the S2 worktree
 * lifecycle (AttemptWorktrees), the S3 judge (judgeAttempts) and the Phase 3
 * check (runCheck), under the §6.1 limits. It refuses to start on a missing
 * price, a missing Phase 4 sandbox, or an invalid log chain — fail closed
 * (§6.1, §7). The judge decides; this module owns appending the write-once
 * `mesh.decision` (§5.3, §6.3) and the per-attempt `mesh.attempt.result`
 * records (§3.1) to the mission's hash-chained log.
 *
 * Decisions this implementation made where the doc left room:
 *  - The S2 lifecycle log is a plain `attempts-log.jsonl` beside the mission
 *    log, so plain lifecycle records never break the mission log's hash chain.
 *  - The kept winner's worktree is moved from the attempts root to
 *    `<missionDir>/kept/<n>` (§4.1 step 7' "the worktree stays"), so the
 *    attempts root ends empty as S4's done-when requires.
 *  - The reservation basis is `maxTokensPerCall ×` the model's output price
 *    (the expensive side); settlement uses the provider-reported usage.
 *  - The per-attempt agent is deliberately minimal for S4: one model call per
 *    rung whose content is JSON `{writes: {path: content}}` applied into the
 *    attempt tree. The full Phase 3 agentic loop is not re-implemented here.
 *  - Model calls are recorded as `model.call` records (usage, settled cost,
 *    response hash) — the P1 `model.*` shape this slice depends on.
 *  - `mesh.route.selected` writes are S5 scope; S4 only logs the start rung
 *    inside `mesh.tournament.started`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  EventLogLock,
  EventLogReader,
  EventLogWriter,
  parseEventLogContent,
} from "@opensand/shared";
import {
  AttemptWorktrees,
  resolveSandboxLauncher,
  type SandboxLauncher,
} from "@opensand/local-exec-daemon";
import { runCheck, type CheckSpec } from "../missions/check.js";
import { cleanGitEnv, treeOf, changedLinesBetweenTrees } from "../missions/workspace-diff.js";
import { judgeAttempts, type JudgeAttempt, type JudgeOptions, type MeshDecision } from "./judge.js";
import { selectStartRung } from "./routing.js";
import type { RoutesConfig } from "./routes-schema.js";
import type { MeshStats, StatsKey } from "./stats.js";
import type { AttemptOutcome, MeshAttemptResultData } from "./types.js";
import { resolveTournamentLimits, type TournamentLimits } from "./limits.js";

export { resolveTournamentLimits } from "./limits.js";

const execAsync = promisify(execFile);

/** Price book: a model's per-token prices in USD per million tokens, and its family. */
export interface ModelCatalogEntry {
  family?: string;
  /** Input price per million tokens. Missing (or a missing entry) refuses the start. */
  priceInUsdPerMTok?: number;
  /** Output price per million tokens; the reservation basis. */
  priceOutUsdPerMTok?: number;
}

export type ModelCatalog = Record<string, ModelCatalogEntry>;

/** One provider call, mapped to the outcomes the §6.1 retry/park rules need. */
export interface ProviderCallResult {
  ok: boolean;
  /** Assistant message content when ok. */
  content?: string;
  /** HTTP status when the provider answered with a non-2xx. */
  httpStatus?: number;
  /** "network" for a transport failure, "http" for a status, "ok" otherwise. */
  errorKind?: "network" | "http";
  usage?: { inputTokens: number | null; outputTokens: number | null } | null;
}

export interface AttemptProvider {
  call(req: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    maxTokens: number;
    signal: AbortSignal;
  }): Promise<ProviderCallResult>;
}

export interface TournamentAttemptRecord {
  n: number;
  result: MeshAttemptResultData;
  snapshotRef?: string;
}

export interface TournamentRun {
  status: "kept" | "failed";
  baseCommit: string;
  startRung: number;
  startModel: string;
  startReason: string;
  attempts: TournamentAttemptRecord[];
  decision: MeshDecision;
  winner: number | null;
  keptBranch: string | null;
  keptPath: string | null;
  totalCostUsd: number;
}

export interface TournamentStartOptions {
  missionId: string;
  /** The target repository the attempts branch from. */
  repoRoot: string;
  /** The engine state dir; the mission log lives at <stateDir>/missions/<id>/log.jsonl. */
  stateDir: string;
  /** The mission task, sent to each attempt's model. */
  task: string;
  role: string;
  routes: RoutesConfig;
  stats: Map<StatsKey, MeshStats>;
  catalog: ModelCatalog;
  checkCommand: string;
  missionBudgetUsd?: number;
  attempts?: number;
  concurrency?: number;
  provider: AttemptProvider;
  /** Stage 2 tie-break reviewer (§2.4); the judge calls it only inside the band. */
  review?: JudgeOptions["review"];
  limits?: Partial<TournamentLimits>;
  /** §7 refuses to start when no sandbox exists. Defaults to the host's real launcher. */
  sandboxLauncher?: SandboxLauncher;
  /** The mission check's sandbox; default "workspace-write" (§7). Pass undefined only on hosts without a sandbox (tests). */
  checkSandbox?: CheckSpec["sandbox"];
  signal?: AbortSignal;
}

/** Thrown when the tournament refuses to start; the reason names the culprit. */
export class TournamentStartRefused extends Error {
  constructor(reason: string) {
    super(`tournament refused to start: ${reason}`);
    this.name = "TournamentStartRefused";
  }
}

function missionDirOf(stateDir: string, missionId: string): string {
  return path.join(stateDir, "missions", missionId);
}

function attemptsLogPath(stateDir: string, missionId: string): string {
  return path.join(missionDirOf(stateDir, missionId), "attempts-log.jsonl");
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execAsync("git", args, { cwd, env: { ...cleanGitEnv() } });
  return stdout;
}

/**
 * Validate the mission log's hash chain before anything appends to it (§6.1:
 * an invalid chain refuses the start).
 */
async function assertLogChainValid(missionLogPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(missionLogPath, "utf8");
  } catch {
    return; // no log yet: the writer creates it
  }
  if (!raw.trim()) return;
  const parsed = (() => {
    try {
      return parseEventLogContent(raw);
    } catch (err) {
      throw new TournamentStartRefused(
        `mission log hash chain is invalid at ${missionLogPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
  if (!parsed.chain.valid) {
    throw new TournamentStartRefused(`mission log hash chain is invalid at ${missionLogPath}`);
  }
}

interface PricedModel {
  model: string;
  family: string;
  priceInPerToken: number;
  priceOutPerToken: number;
}

function priceModel(model: string, catalog: ModelCatalog): PricedModel {
  const entry = catalog[model];
  if (
    !entry ||
    typeof entry.priceInUsdPerMTok !== "number" ||
    typeof entry.priceOutUsdPerMTok !== "number"
  ) {
    throw new TournamentStartRefused(
      `no price in the model catalog for ${model}; an unknown cost is not a small cost`,
    );
  }
  return {
    model,
    family: entry.family ?? "unknown",
    priceInPerToken: entry.priceInUsdPerMTok / 1_000_000,
    priceOutPerToken: entry.priceOutUsdPerMTok / 1_000_000,
  };
}

/**
 * Settle the `mesh.decision` for a round (§5.3/§6.3): written once per inputs
 * hash. A second settle with the same inputs returns the existing decision and
 * appends nothing, because the log is append-only. The existence check and the
 * append both sit behind the log lock; the append itself re-reads the head
 * under its own lock, so a crash between the two cannot fork the chain.
 */
export async function settleMeshDecision(
  missionLogPath: string,
  decision: MeshDecision,
): Promise<{ decision: MeshDecision; appended: boolean }> {
  const dir = path.dirname(missionLogPath);
  const lock = await EventLogLock.acquire(dir);
  let existing: MeshDecision | undefined;
  try {
    const entries = await new EventLogReader(missionLogPath).readAll();
    existing = entries.find(
      (e) =>
        e.kind === "mesh.decision" &&
        (e.data as MeshDecision | undefined)?.inputsHash === decision.inputsHash,
    )?.data as MeshDecision | undefined;
  } finally {
    await lock.release();
  }
  if (existing) return { decision: existing, appended: false };
  const writer = new EventLogWriter(missionLogPath, { sessionId: path.basename(dir) });
  await writer.append({ kind: "mesh.decision", data: decision });
  return { decision, appended: true };
}

interface AttemptRunState {
  n: number;
  outcome: AttemptOutcome;
  result: MeshAttemptResultData;
  finalTree?: string;
  checkOutput?: string;
  diffText?: string;
  snapshotRef?: string;
}

/**
 * Run one tournament. See the module doc for the state machine and the
 * decisions. Throws TournamentStartRefused when a precheck fails.
 */
export async function startTournament(options: TournamentStartOptions): Promise<TournamentRun> {
  // Explicit undefined must not clobber a default: keep only defined overrides.
  const overrides: Partial<TournamentLimits> = {};
  for (const [key, value] of Object.entries({
    ...options.limits,
    attempts: options.attempts ?? options.limits?.attempts,
    concurrency: options.concurrency ?? options.limits?.concurrency,
    missionBudgetUsd: options.missionBudgetUsd ?? options.limits?.missionBudgetUsd,
  })) {
    if (value !== undefined) (overrides as Record<string, unknown>)[key] = value;
  }
  const limits = resolveTournamentLimits(overrides);

  const roleRouting = options.routes.roles[options.role];
  if (!roleRouting) {
    throw new TournamentStartRefused(`no ladder configured for role ${options.role}`);
  }
  if (roleRouting.ladder.length === 0) {
    throw new TournamentStartRefused(`empty ladder for role ${options.role}`);
  }
  // Fail closed on a missing price for ANY ladder model: escalation walks the
  // whole ladder, so a priceless rung is a start-time problem (§9 row 10).
  const pricedLadder = roleRouting.ladder.map((m) => priceModel(m, options.catalog));

  const sandboxLauncher =
    options.sandboxLauncher ?? resolveSandboxLauncher(process.platform, process.env);
  if (sandboxLauncher.kind === "unavailable") {
    throw new TournamentStartRefused(
      `no sandbox on this host (${sandboxLauncher.reason}); an attempt cannot ask in the background`,
    );
  }

  const missionDir = missionDirOf(options.stateDir, options.missionId);
  const missionLogPath = path.join(missionDir, "event-log.jsonl");
  await assertLogChainValid(missionLogPath);

  const baseCommit = (await git(["rev-parse", "HEAD"], options.repoRoot)).trim();

  const start = selectStartRung(options.role, roleRouting.ladder, options.stats);

  const writer = new EventLogWriter(missionDir, { sessionId: options.missionId });
  await writer.append({
    sessionId: options.missionId,
    node: "tournament",
    kind: "mesh.tournament.started",
    data: {
      base: baseCommit,
      attempts: limits.attempts,
      concurrency: limits.concurrency,
      role: options.role,
      rung: start.rung,
      model: start.model,
      reason: start.reason,
    },
  });

  const worktrees = new AttemptWorktrees({
    repoRoot: options.repoRoot,
    attemptsRoot: path.join(missionDir, "attempts"),
    missionId: options.missionId,
    baseCommit,
    logPath: attemptsLogPath(options.stateDir, options.missionId),
  });

  const attemptCapUsd =
    limits.missionBudgetUsd !== undefined ? limits.missionBudgetUsd / limits.attempts : Infinity;
  const mission = { spentUsd: 0 };
  const results: AttemptRunState[] = [];

  // Worker pool over attempt numbers, at most `concurrency` at once (§4.2).
  let nextAttempt = 1;
  const next = () => (nextAttempt <= limits.attempts ? nextAttempt++ : null);
  const runOne = async (n: number) => {
    results.push(await runAttempt(n, { options, limits, worktrees, writer, ladder: pricedLadder, startRung: start.rung, attemptCapUsd, mission, baseCommit }));
  };
  await Promise.all(
    Array.from({ length: Math.min(limits.concurrency, limits.attempts) }, async () => {
      for (;;) {
        const n = next();
        if (n === null) return;
        await runOne(n);
      }
    }),
  );
  results.sort((a, b) => a.n - b.n);

  // Judge (§5) over the finished attempts. Trees still exist: diffs are read
  // before any loser is snapshotted or removed.
  const judged: JudgeAttempt[] = results.map((r) => ({
    n: r.n,
    result: r.result,
    diff: r.diffText,
    checkOutput: r.checkOutput,
  }));
  const decision = await judgeAttempts(judged, {
    maxDiffLines: limits.maxDiffLines,
    review: options.review,
  });
  const settled = await settleMeshDecision(missionLogPath, decision);

  // Step 7'/7: keep the winner, snapshot and remove every loser.
  let keptBranch: string | null = null;
  let keptPath: string | null = null;
  for (const r of results) {
    if (settled.decision.winner === r.n) {
      await worktrees.keep(r.n);
      const branch = `opensand/${options.missionId}/${r.n}`;
      // The kept worktree stays (§4.1 step 7'), just outside the attempts
      // root, so cleanup leaves the attempts root empty.
      const keptDir = path.join(missionDir, "kept", String(r.n));
      await fs.mkdir(path.dirname(keptDir), { recursive: true });
      try {
        await git(["worktree", "move", worktrees.attemptPath(r.n), keptDir], options.repoRoot);
        keptPath = keptDir;
      } catch {
        // The move is cosmetic: the branch and worktree already exist, so a
        // failed move leaves the kept tree in place rather than losing work.
      }
      keptBranch = branch;
    } else {
      r.snapshotRef = await worktrees.snapshot(r.n);
      await worktrees.remove(r.n);
    }
  }

  const totalCostUsd = results.reduce((sum, r) => sum + (r.result.costUsd ?? 0), 0);
  await writer.append({
    sessionId: options.missionId,
    node: "tournament",
    kind: "mesh.tournament.finished",
    data: {
      base: baseCommit,
      status: settled.decision.winner === null ? "failed" : "kept",
      winner: settled.decision.winner,
      keptBranch,
      attempts: results.map((r) => ({ n: r.n, outcome: r.result.outcome, costUsd: r.result.costUsd })),
      totalCostUsd,
      decisionAppended: settled.appended,
    },
  });

  return {
    status: settled.decision.winner === null ? "failed" : "kept",
    baseCommit,
    startRung: start.rung,
    startModel: start.model,
    startReason: start.reason,
    attempts: results.map((r) => ({ n: r.n, result: r.result, snapshotRef: r.snapshotRef })),
    decision: settled.decision,
    winner: settled.decision.winner,
    keptBranch,
    keptPath,
    totalCostUsd,
  };
}

/**
 * Crash recovery for a mission's tournament (§4.3), plus the
 * `mesh.attempt.result` records a crash window may have left unwritten.
 * Interrupted attempts are reconstructed with `model: "unknown"`; they are
 * never counted for routing (§3.1).
 */
export async function reconcileTournament(options: {
  missionId: string;
  repoRoot: string;
  stateDir: string;
}): Promise<Array<{ attempt: number; action: string }>> {
  const missionDir = missionDirOf(options.stateDir, options.missionId);
  const aLogPath = attemptsLogPath(options.stateDir, options.missionId);
  // The base commit is replayed from the tournament record, not re-derived:
  // reconcile must rebuild the same attempt shape the crashed run used.
  const missionLogPath = path.join(missionDir, "event-log.jsonl");
  const missionEvents = await new EventLogReader(missionLogPath).readAll();
  const started = missionEvents
    .filter((e) => e.kind === "mesh.tournament.started")
    .pop() as { data: { base?: string } } | undefined;
  const baseCommit = started?.data?.base;
  if (!baseCommit) return [];

  const worktrees = new AttemptWorktrees({
    repoRoot: options.repoRoot,
    attemptsRoot: path.join(missionDir, "attempts"),
    missionId: options.missionId,
    baseCommit,
    logPath: aLogPath,
  });
  const report = await worktrees.reconcile();

  // Append the mesh.attempt.result records the crash window skipped.
  const recorded = new Set(
    missionEvents
      .filter((e) => e.kind === "mesh.attempt.result")
      .map((e) => (e as unknown as { attempt: number }).attempt),
  );
  // The attempts log is plain JSONL (not hash-chained); read it leniently.
  const finished = new Map<number, string>();
  try {
    const raw = await fs.readFile(aLogPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { kind?: string; n?: number; outcome?: string };
        if (r.kind === "attempt.finished" && typeof r.n === "number") {
          finished.set(r.n, r.outcome ?? "interrupted");
        }
      } catch {
        // Trailing fragment from a crash; ignore the partial line.
      }
    }
  } catch {
    // No attempts log: nothing to reconcile.
  }
  const writer = new EventLogWriter(missionDir, { sessionId: options.missionId });
  for (const [n, outcome] of finished) {
    if (recorded.has(n)) continue;
    await writer.append({
      sessionId: options.missionId,
      attempt: n,
      node: "tournament",
      kind: "mesh.attempt.result",
      data: {
        role: "coder",
        model: "unknown",
        outcome: (outcome as AttemptOutcome) ?? "interrupted",
      },
    });
  }
  return report;
}

// ---- one attempt ----

interface RunAttemptContext {
  options: TournamentStartOptions;
  limits: TournamentLimits;
  worktrees: AttemptWorktrees;
  writer: EventLogWriter;
  ladder: PricedModel[];
  startRung: number;
  attemptCapUsd: number;
  mission: { spentUsd: number };
  baseCommit: string;
}

async function runAttempt(n: number, ctx: RunAttemptContext): Promise<AttemptRunState> {
  const { options, limits } = ctx;
  const attemptStart = Date.now();

  // One timer per attempt (§6.1 wall clock): the abort is what stops the
  // in-flight model call and the check; `timedOut` tells timeout apart from
  // an outer (mission) abort, which records `interrupted`.
  const attemptAbort = new AbortController();
  let timedOut = false;
  const attemptTimer = setTimeout(() => {
    timedOut = true;
    attemptAbort.abort();
  }, limits.perAttemptWallClockMs);
  const onOuterAbort = () => attemptAbort.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const abortOutcome = (): AttemptOutcome => (timedOut ? "timeout" : "interrupted");

  const state: AttemptRunState = {
    n,
    outcome: "interrupted",
    result: { role: options.role, model: "", outcome: "interrupted" },
  };

  try {
    await worktreesLifecycle(ctx, n, state, attemptAbort, abortOutcome, attemptStart);
    return state;
  } finally {
    clearTimeout(attemptTimer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

async function worktreesLifecycle(
  ctx: RunAttemptContext,
  n: number,
  state: AttemptRunState,
  attemptAbort: AbortController,
  abortOutcome: () => AttemptOutcome,
  attemptStart: number,
): Promise<void> {
  const { options, limits, worktrees } = ctx;

  await worktrees.reserve(n);
  await worktrees.create(n);
  const tree = worktrees.attemptPath(n);
  await worktrees.markRunning(n);

  let rung = ctx.startRung;
  let escalations = 0;
  let escalatedFrom: string | undefined;
  let spentUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let costKnown = true;
  let containmentEvents = 0;

  for (;;) {
    if (attemptAbort.signal.aborted) {
      state.outcome = abortOutcome();
      state.result = attemptResult(options, ctx.ladder[rung]!, state.outcome, {
        rung,
        escalatedFrom,
        costUsd: costKnown ? spentUsd : null,
        wallMs: Date.now() - attemptStart,
        tokensIn,
        tokensOut,
        containmentEvents,
      });
      break;
    }
    const priced = ctx.ladder[rung]!;

    // Reservation before the call (§6.1): maxTokens × output price, against
    // the attempt cap and the mission budget. Fail closed, never silently
    // continue past a limit.
    const reserveUsd = limits.maxTokensPerCall * priced.priceOutPerToken;
    if (
      spentUsd + reserveUsd > ctx.attemptCapUsd ||
      ctx.mission.spentUsd + reserveUsd > (limits.missionBudgetUsd ?? Infinity)
    ) {
      state.outcome = "budget_stopped";
      state.result = attemptResult(options, priced, "budget_stopped", {
        rung,
        escalatedFrom,
        costUsd: costKnown ? spentUsd : null,
        wallMs: Date.now() - attemptStart,
        tokensIn,
        tokensOut,
        containmentEvents,
      });
      break;
    }

    const recordCall = async (
      result: ProviderCallResult,
      durationMs: number,
    ): Promise<CallDone["settle"]> => {
      const usage = result.ok ? (result.usage ?? null) : null;
      const usageCost =
        usage && usage.inputTokens !== null && usage.outputTokens !== null
          ? usage.inputTokens * priced.priceInPerToken + usage.outputTokens * priced.priceOutPerToken
          : null;
      // One model.call record per call, ok or not, with the settled cost: the
      // cost ledger counts infra failures too (§3.1), and replay never
      // re-calls a model — the response is stored by hash (§6.3).
      await ctx.writer.append({
        sessionId: options.missionId,
        attempt: n,
        node: "tournament",
        kind: "model.call",
        data: {
          model: priced.model,
          family: priced.family,
          rung,
          status: result.ok ? "ok" : "error",
          httpStatus: result.httpStatus,
          errorKind: result.errorKind,
          usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : null,
          costUsd: usageCost,
          contentSha256: result.ok ? createHash("sha256").update(result.content ?? "").digest("hex") : undefined,
          durationMs,
        },
      });
      return { costUsd: usageCost, usage };
    };
    const callResult = await callWithRetries(options, limits, priced, attemptAbort, recordCall);
    if (callResult.aborted) {
      state.outcome = abortOutcome();
      break;
    }
    if (!callResult.value.ok) {
      // Retries exhausted (or a 402 park): the attempt ends infra_error on
      // the same rung — escalation never burns the next rung on a down
      // provider (§6.1).
      state.outcome = "infra_error";
      state.result = attemptResult(options, priced, "infra_error", {
        rung,
        escalatedFrom,
        costUsd: costKnown ? spentUsd : null,
        wallMs: Date.now() - attemptStart,
        tokensIn,
        tokensOut,
        containmentEvents,
      });
      break;
    }
    const call = callResult.value;

    // Settle to the recorded usage: what the provider reported on the wire is
    // what the mission pays (P1). A missing usage block must never look like a
    // free call, so an unknown cost is carried as null into the result.
    const usage = callResult.settle.usage;
    const usageCost = callResult.settle.costUsd;
    void 0;
    if (usageCost === null) costKnown = false;
    const settleUsd = usageCost ?? 0;
    spentUsd += settleUsd;
    ctx.mission.spentUsd += settleUsd;
    if (usage) {
      tokensIn += usage.inputTokens ?? 0;
      tokensOut += usage.outputTokens ?? 0;
    }

    // The S4 attempt agent: content is JSON {writes: {path: content}}.
    const writes = parseModelWrites(call.content, () => containmentEvents++);
    for (const w of writes) {
      const target = path.join(tree, w.rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, w.content, "utf8");
    }

    let checkResult: Awaited<ReturnType<typeof runCheck>>;
    try {
      checkResult = await runCheck(
        { command: options.checkCommand, sandbox: options.checkSandbox ?? "workspace-write" },
        tree,
        { signal: attemptAbort.signal },
      );
      if (attemptAbort.signal.aborted) {
        state.outcome = abortOutcome();
        break;
      }
    } catch {
      state.outcome = attemptAbort.signal.aborted ? abortOutcome() : "infra_error";
      break;
    }
    await worktrees.markChecked(n, checkResult.exitCode ?? 1);

    const finalTree = await treeOf(tree);
    let diffLines = 0;
    let filesChanged = 0;
    if (finalTree.available && finalTree.tree) {
      const changes = await changedLinesBetweenTrees(ctx.baseCommit, finalTree.tree, tree);
      if (Array.isArray(changes)) {
        filesChanged = changes.length;
        diffLines = changes.reduce((sum, f) => sum + f.ranges.length, 0);
        const { stdout } = await execAsync("git", ["diff", "--no-color", ctx.baseCommit, finalTree.tree], {
          cwd: options.repoRoot,
          env: { ...cleanGitEnv() },
        });
        state.diffText = stdout;
        state.finalTree = finalTree.tree;
      }
    }
    state.checkOutput = checkResult.outputTail;

    const outcome: AttemptOutcome = !checkResult.passed
      ? "check_failed"
      : diffLines > 0
        ? "passed"
        : "no_change";
    state.result = attemptResult(options, priced, outcome, {
      rung,
      escalatedFrom,
      checkExit: checkResult.exitCode ?? undefined,
      diffLines,
      filesChanged,
      costUsd: costKnown ? spentUsd : null,
      wallMs: Date.now() - attemptStart,
      tokensIn,
      tokensOut,
      containmentEvents,
    });

    if (outcome === "passed") {
      state.outcome = "passed";
      break;
    }
    // Only model outcomes move up the ladder (§6.1); infra outcomes retry or
    // park on the same rung, never escalate.
    const escalates =
      (outcome === "check_failed" || outcome === "no_change") &&
      rung + 1 < ctx.ladder.length &&
      escalations < limits.maxEscalations;
    if (!escalates) {
      state.outcome = outcome;
      break;
    }
    escalations++;
    escalatedFrom = priced.model;
    rung++;
  }

  // A crash window between the state machine and the record is what the
  // `interrupted` outcome names; here the loop just ended early, so make the
  // recorded outcome and the final state agree before step 5 appends.
  if (state.outcome !== state.result.outcome) {
    state.result = { ...state.result, outcome: state.outcome };
  }
  await worktrees.finish(n, state.outcome);
  // mesh.attempt.result: one record per finished attempt (§3.1), appended to
  // the mission log right after `attempt.finished` (§4.1 step 5).
  await ctx.writer.append({
    sessionId: options.missionId,
    attempt: n,
    node: "tournament",
    kind: "mesh.attempt.result",
    data: state.result,
  });
}

function attemptResult(
  options: TournamentStartOptions,
  priced: PricedModel,
  outcome: AttemptOutcome,
  extra: Partial<MeshAttemptResultData> & { rung: number; escalatedFrom?: string },
): MeshAttemptResultData {
  return {
    role: options.role,
    model: priced.model,
    family: priced.family,
    outcome,
    ...extra,
  };
}

interface CallOutcome {
  readonly aborted: true;
}
interface CallDone {
  readonly aborted: false;
  readonly value: ProviderCallResult & { durationMs: number };
  /** The settled cost and usage of the last (ok) call, from the recorder. */
  readonly settle: {
    costUsd: number | null;
    usage: { inputTokens: number | null; outputTokens: number | null } | null;
  };
}

async function callWithRetries(
  options: TournamentStartOptions,
  limits: TournamentLimits,
  priced: PricedModel,
  attemptAbort: AbortController,
  onCall: (result: ProviderCallResult, durationMs: number) => Promise<CallDone["settle"]> | CallDone["settle"],
): Promise<CallOutcome | CallDone> {
  const start = Date.now();
  const settle: CallDone["settle"] = { costUsd: null, usage: null };
  for (let retry = 0; ; retry++) {
    if (attemptAbort.signal.aborted) return { aborted: true } as CallOutcome;
    let result: ProviderCallResult;
    try {
      result = await options.provider.call({
        model: priced.model,
        messages: [{ role: "user", content: options.task }],
        maxTokens: limits.maxTokensPerCall,
        signal: attemptAbort.signal,
      });
    } catch (err) {
      if (attemptAbort.signal.aborted) return { aborted: true } as CallOutcome;
      result = { ok: false, errorKind: "network" };
    }
    const recorded = await onCall(result, Date.now() - start);
    settle.costUsd = recorded.costUsd;
    settle.usage = recorded.usage;
    if (result.ok) return { aborted: false, value: { ...result, durationMs: Date.now() - start }, settle } satisfies CallDone;
    // 402 parks at once: retrying does not change the balance (§6.1).
    if (result.httpStatus === 402) return { aborted: false, value: { ...result, durationMs: Date.now() - start }, settle } satisfies CallDone;
    const retryable =
      result.errorKind === "network" ||
      result.httpStatus === 429 ||
      (result.httpStatus !== undefined && result.httpStatus >= 500);
    if (!retryable || retry >= limits.infraRetries) {
      return { aborted: false, value: { ...result, durationMs: Date.now() - start }, settle } satisfies CallDone;
    }
    const backoff = limits.infraBackoffMs[Math.min(retry, limits.infraBackoffMs.length - 1)] ?? 1000;
    await sleep(backoff, attemptAbort.signal);
  }
}

/** The S4 agent protocol: content is JSON `{writes: {relPath: content}}`. */
function parseModelWrites(content: string | undefined, onEscape: () => void): Array<{ rel: string; content: string }> {
  let writes: Array<{ rel: string; content: string }> = [];
  try {
    const parsed: unknown = JSON.parse(content ?? "");
    const writesRaw = (parsed as { writes?: unknown })?.writes;
    if (writesRaw && typeof writesRaw === "object") {
      for (const [rel, fileContent] of Object.entries(writesRaw as Record<string, unknown>)) {
        if (typeof fileContent !== "string") continue;
        if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
          onEscape(); // an attempt may only write inside its tree (§7)
          continue;
        }
        writes.push({ rel, content: fileContent });
      }
    }
  } catch {
    // Unparseable content: an attempt that writes nothing fails the check.
  }
  return writes;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/** A minimal OpenAI-compatible provider over HTTP; the test stub serves this shape. */
export function openAiCompatProvider(
  baseUrl: string,
  opts: { fetch?: typeof globalThis.fetch; apiKey?: string } = {},
): AttemptProvider {
  const doFetch = opts.fetch ?? globalThis.fetch;
  return {
    async call(req) {
      try {
        const res = await doFetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: req.model,
            messages: req.messages,
            max_tokens: req.maxTokens,
            stream: false,
          }),
          signal: req.signal,
        });
        if (!res.ok) {
          return { ok: false, httpStatus: res.status, errorKind: "http" as const };
        }
        const body = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number | null; completion_tokens?: number | null };
        };
        return {
          ok: true,
          content: body.choices?.[0]?.message?.content ?? "",
          usage: {
            inputTokens: body.usage?.prompt_tokens ?? null,
            outputTokens: body.usage?.completion_tokens ?? null,
          },
        };
      } catch (err) {
        if (req.signal.aborted) throw err; // the attempt timer owns timeouts
        return { ok: false, errorKind: "network" as const };
      }
    },
  };
}
