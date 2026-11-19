import { START, END, StateGraph } from "@opensand/shared";
import { EventLogWriter, EventLogReader } from "@opensand/shared";
import { wrapUntrusted, escapeUntrustedText } from "@opensand/shared";
import { MISSION_EVENT, FolderTrustStore, GrantsStore, resolveSandboxProfile } from "@opensand/shared";
import type { EventFrame } from "@opensand/protocol";
import { logDirFor, eventNameForKind } from "../reconnect.js";
import { runCheck, type CheckResult } from "./check.js";
import { LocalWorkspace, type MissionWorkspace, type WorkspaceResult } from "./workspace.js";
import { treeOf, changedLinesBetweenTrees, pinTrees, createStepSnapshot, type ChangesResult } from "./workspace-diff.js";
import type { TournamentRun } from "../mesh/tournament.js";
import { projectReceipt } from "./receipt.js";
import type { MissionAgent } from "./agent.js";
import type { FolderTrustGate } from "./trust-gate.js";

export interface MissionBudget {
  maxRepairs: number;
  wallClockMs?: number;
  budgetUsd?: number;
}

/**
 * The tournament node's injected runner (S4). The mission graph swaps its act
 * node for this one when set; S5 wires the default implementation that loads
 * routes.json, stats and the catalog.
 */
export interface TournamentNodeConfig {
  run: (ctx: {
    missionId: string;
    workspaceRoot: string;
    checkCommand: string;
    budgetUsd?: number;
    signal: AbortSignal;
  }) => Promise<TournamentRun>;
}

export interface MissionOptions {
  missionId: string;
  workspaceRoot: string;
  title: string;
  initialQuery: string;
  checkCommand: string;
  /** Named target from targets.json; "local" (default) keeps the Phase 3 path. */
  target?: string;
  /** Prebuilt workspace (manager resolves the target). Defaults to a local workspace. */
  workspace?: MissionWorkspace;
  budget?: Partial<MissionBudget>;
  tournament?: TournamentNodeConfig;
  forkedFrom?: {
    missionId: string;
    snapshot: string;
    targetTree: string;
  };
}

interface MissionState extends Record<string, unknown> {
  missionId: string;
  workspaceRoot: string;
  initialQuery: string;
  checkCommand: string;
  title: string;
  baseTree?: string;
  finalTree?: string;
  plan: string[];
  claim?: string;
  repairRounds: number;
  checks: CheckResult[];
  lastCheck?: CheckResult;
  lastFailure?: { exitCode: number; outputTail: string };
  lastReview?: { accept: boolean; note: string };
  tournament?: { status: string; winner: number | null; keptBranch: string | null };
  changes?: ChangesResult;
  failedReason?: { code: number; message: string; node: string };
}

export class MissionRunner {
  readonly missionId: string;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly initialQuery: string;
  readonly checkCommand: string;
  readonly budget: MissionBudget;
  private readonly options: MissionOptions;
  private readonly stateDir: string;
  private readonly agent: MissionAgent;
  private readonly gate: FolderTrustGate;
  private readonly grants: GrantsStore;
  private readonly publishFrame: (frame: EventFrame) => void;
  private readonly writer: EventLogWriter;
  private readonly abortController = new AbortController();
  private startTime = 0;
  private currentNode = "plan";
  private executionPromise?: Promise<void>;
  private isFinished = false;
  private trustedFolder = "";
  private snapshotSeq = 0;
  private readonly workspace: MissionWorkspace;
  private prepared = false;
  private preparedTree?: string;

  constructor(
    options: MissionOptions,
    context: {
      stateDir: string;
      agent: MissionAgent;
      gate: FolderTrustGate;
      grants: GrantsStore;
      publish: (frame: EventFrame) => void;
    }
  ) {
    this.options = options;
    this.workspace = options.workspace ?? new LocalWorkspace(options.workspaceRoot);
    this.missionId = options.missionId;
    this.workspaceRoot = options.workspaceRoot;
    this.title = options.title;
    this.initialQuery = options.initialQuery;
    this.checkCommand = options.checkCommand;
    this.budget = {
      maxRepairs: options.budget?.maxRepairs ?? 3,
      wallClockMs: options.budget?.wallClockMs,
      budgetUsd: options.budget?.budgetUsd,
    };
    this.stateDir = context.stateDir;
    this.agent = context.agent;
    this.gate = context.gate;
    this.grants = context.grants;
    this.publishFrame = context.publish;

    const logDir = logDirFor(this.stateDir, "mission", this.missionId);
    this.writer = new EventLogWriter(logDir, { sessionId: this.missionId });
  }

  get aborted(): boolean {
    return this.abortController.signal.aborted;
  }

  get finished(): boolean {
    return this.isFinished;
  }

  start(): Promise<void> {
    if (this.executionPromise) return this.executionPromise;
    this.startTime = Date.now();
    this.executionPromise = this.run().finally(() => {
      this.isFinished = true;
    });
    return this.executionPromise;
  }

  cancel(): void {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
    }
  }

  private async appendAndPublish(
    kind: string,
    data: Record<string, unknown>,
    node?: string
  ): Promise<void> {
    const ev = await this.writer.append({
      sessionId: this.missionId,
      node,
      kind,
      data,
    });

    const frame: EventFrame = {
      event: eventNameForKind(kind) as any,
      seq: ev.seq,
      ts: ev.ts,
      data: { ...data, logKind: kind, missionId: this.missionId },
    };
    this.publishFrame(frame);
  }

  /** One event per target phase; local is unnamed and records nothing. */
  private async emitTarget(
    phase: string,
    detail?: string,
    extra?: { result?: string; tree?: string }
  ): Promise<void> {
    const id = this.workspace.identity();
    if (!id) return;
    const result =
      extra?.result ?? (phase === "apply" && this.workspace.kind === "container" ? "bind" : undefined);
    await this.appendAndPublish(MISSION_EVENT.TARGET, {
      missionId: this.missionId,
      phase,
      name: id.name,
      kind: id.kind,
      ...(id.platform ? { platform: id.platform } : {}),
      ...(id.root ? { root: id.root } : {}),
      ...(result ? { result } : {}),
      ...(detail ? { detail } : {}),
      ...(extra?.tree ? { tree: extra.tree } : {}),
    });
  }

  /** Fetch the remote result into staging before review so the diff is real. */
  private async prepareWorkspace(): Promise<void> {
    if (this.prepared) return;
    this.prepared = true;
    const res: WorkspaceResult = await this.workspace.prepare();
    this.preparedTree = res.tree;
    await this.emitTarget("prepare", res.detail, { tree: res.tree });
  }

  /**
   * Connect before the trust gate and always close, including cancel and
   * shutdown (both abort this run). A preflight/push failure ends the mission
   * before anything local is written.
   */
  private async run(): Promise<void> {
    try {
      await this.workspace.begin();
      await this.emitTarget("connect");
      if (this.workspace.kind === "ssh") await this.emitTarget("push");
    } catch (err: any) {
      await this.emitTarget("failed", err?.message ?? "target link failed", { result: "failed" });
      await this.appendAndPublish(MISSION_EVENT.FAILED, {
        missionId: this.missionId,
        error: { code: 4003, message: `target setup failed: ${err?.message ?? "unknown"}` },
        node: "runner",
      });
      await this.workspace.close().catch(() => undefined);
      return;
    }
    try {
      await this.runInner();
    } finally {
      await this.workspace.close().catch(() => undefined);
    }
  }

  /**
   * Tree of the workspace as it is now, plus the changed lines against the
   * base tree. For SSH, `overrideTree` is the prepared staging tree. Never
   * touches the user's index, branch or stash.
   */
  private async snapshot(
    baseTree: string | undefined,
    overrideTree?: string
  ): Promise<{ finalTree?: string; changes: ChangesResult }> {
    try {
      const finalRes = overrideTree
        ? { available: true, tree: overrideTree }
        : await treeOf(this.workspaceRoot);
      if (!finalRes.available || !finalRes.tree) {
        return {
          changes: { available: false, reason: finalRes.reason ?? "not a git repository" },
        };
      }
      if (!baseTree) {
        return { finalTree: finalRes.tree, changes: { available: false, reason: "no base tree" } };
      }
      const changes = await changedLinesBetweenTrees(baseTree, finalRes.tree, this.workspaceRoot);
      return { finalTree: finalRes.tree, changes };
    } catch {
      return { changes: { available: false, reason: "failed to compute diff" } };
    }
  }

  private async runInner(): Promise<void> {
    // Log-only; no command runs before the folder-trust gate below.
    if (!this.options.forkedFrom) {
      const target = this.workspace.identity();
      await this.appendAndPublish(MISSION_EVENT.STARTED, {
      missionId: this.missionId,
      title: this.title,
      workspaceRoot: this.workspaceRoot,
      budgetUsd: this.budget.budgetUsd ?? 0,
      ...(target ? { target: { name: target.name, kind: target.kind } } : {}),
    });
    }

    let trust;
    try {
      trust = await this.gate.resolve(
        this.missionId,
        this.workspaceRoot,
        this.abortController.signal,
        (q) => this.appendAndPublish(MISSION_EVENT.NEEDS_YOU, { missionId: this.missionId, ...q }),
        (a) => this.appendAndPublish(MISSION_EVENT.ANSWERED, { missionId: this.missionId, ...a }),
      );
    } catch (err: any) {
      if (err?.name === "AbortError") {
        await this.appendAndPublish(MISSION_EVENT.STOPPED, { missionId: this.missionId, reason: "cancelled" });
        return;
      }
      throw err;
    }
    if (trust.level === "untrusted") {
      // The agent writes with fs, not a command, so a sandbox profile would not confine it: stop.
      await this.appendAndPublish(MISSION_EVENT.STOPPED, { missionId: this.missionId, reason: "folder-untrusted" });
      return;
    }
    this.trustedFolder = trust.folder;

    let baseTree: string | undefined;
    try {
      const baseRes = await treeOf(this.workspaceRoot);
      if (baseRes.available) {
        baseTree = baseRes.tree;
      }
    } catch {
      // workspace might not be git
    }

    const graph = new StateGraph<MissionState>();

    // 1. plan node
    graph.addNode("plan", async (state) => {
      if (this.abortController.signal.aborted) return;
      this.currentNode = "plan";
      const start = Date.now();
      await this.appendAndPublish(
        MISSION_EVENT.NODE_STARTED,
        { missionId: this.missionId, node: "plan", attempt: 1 },
        "plan"
      );

      const plan = await this.agent.plan(state.initialQuery, {
        workspaceRoot: state.workspaceRoot,
        missionId: state.missionId,
        workspace: this.workspace,
      });

      await this.appendAndPublish(
        MISSION_EVENT.NODE_COMPLETED,
        { missionId: this.missionId, node: "plan", durationMs: Date.now() - start },
        "plan"
      );

      return { plan };
    });

    // 2. act node
    graph.addNode("act", async (state) => {
      if (this.abortController.signal.aborted) return;
      this.currentNode = "act";
      const start = Date.now();
      const attempt = state.repairRounds + 1;
      let snapshotRef: string | undefined;
      try {
        const snap = await createStepSnapshot(
          this.workspaceRoot,
          this.missionId,
          ++this.snapshotSeq
        );
        if (snap?.ref) {
          snapshotRef = snap.ref;
        }
      } catch (err) {
        console.error(`Snapshot failed before act node in mission ${this.missionId}:`, err);
      }

      await this.appendAndPublish(
        MISSION_EVENT.NODE_STARTED,
        {
          missionId: this.missionId,
          node: "act",
          attempt,
          ...(snapshotRef ? { snapshot: snapshotRef } : {}),
        },
        "act"
      );

      const { claim } = await this.agent.act(
        {
          goal: state.initialQuery,
          plan: state.plan,
          failure: state.lastFailure
            ? {
                ...state.lastFailure,
                outputTail: wrapUntrusted(state.lastFailure.outputTail, { source: "command", origin: "check" }),
              }
            : undefined,
        },
        {
          workspaceRoot: state.workspaceRoot,
          missionId: state.missionId,
          workspace: this.workspace,
        }
      );

      await this.appendAndPublish(
        MISSION_EVENT.NODE_COMPLETED,
        {
          missionId: this.missionId,
          node: "act",
          claim,
          durationMs: Date.now() - start,
        },
        "act"
      );

      return { claim };
    });

    // 2b. tournament node (S4): replaces the act node when a tournament is
    // configured. The mission's per-attempt checks are the tournament's own;
    // the mission-level check still runs afterwards over the workspace.
    if (this.options.tournament) {
      graph.addNode("tournament", async (state) => {
        if (this.abortController.signal.aborted) return;
        this.currentNode = "tournament";
        const start = Date.now();
        await this.appendAndPublish(
          MISSION_EVENT.NODE_STARTED,
          { missionId: this.missionId, node: "tournament", attempt: 1 },
          "tournament"
        );

        const run = await this.options.tournament!.run({
          missionId: this.missionId,
          workspaceRoot: state.workspaceRoot,
          checkCommand: state.checkCommand,
          budgetUsd: this.budget.budgetUsd,
          signal: this.abortController.signal,
        });

        await this.appendAndPublish(
          MISSION_EVENT.NODE_COMPLETED,
          {
            missionId: this.missionId,
            node: "tournament",
            status: run.status,
            winner: run.winner,
            keptBranch: run.keptBranch,
            attempts: run.attempts.length,
            durationMs: Date.now() - start,
          },
          "tournament"
        );

        return {
          tournament: { status: run.status, winner: run.winner, keptBranch: run.keptBranch },
        };
      });
    }

    // 3. check node
    graph.addNode("check", async (state) => {
      if (this.abortController.signal.aborted) return;
      this.currentNode = "check";
      const start = Date.now();
      const attempt = state.checks.length + 1;
      await this.appendAndPublish(
        MISSION_EVENT.NODE_STARTED,
        { missionId: this.missionId, node: "check", attempt },
        "check"
      );

      const sandbox = resolveSandboxProfile({
        level: "trusted",
        requested: undefined,
        grants: (await this.grants.read()).grants,
        folder: this.trustedFolder,
      });
      const checkResult = await runCheck(
        { command: state.checkCommand, sandbox },
        state.workspaceRoot,
        { signal: this.abortController.signal, exec: (input, opts) => this.workspace.exec(input, opts) }
      );

      await this.appendAndPublish(
        MISSION_EVENT.CHECK_COMPLETED,
        {
          missionId: this.missionId,
          exitCode: checkResult.exitCode,
          signal: checkResult.signal,
          durationMs: checkResult.durationMs,
          passed: checkResult.passed,
          outputTail: checkResult.outputTail,
        },
        "check"
      );

      await this.appendAndPublish(
        MISSION_EVENT.NODE_COMPLETED,
        {
          missionId: this.missionId,
          node: "check",
          exitCode: checkResult.exitCode ?? undefined,
          durationMs: Date.now() - start,
          passed: checkResult.passed,
        },
        "check"
      );

      return {
        lastCheck: checkResult,
        checks: [...state.checks, checkResult],
      };
    });

    // 4. repair node
    graph.addNode("repair", async (state) => {
      if (this.abortController.signal.aborted) return;
      this.currentNode = "repair";
      const start = Date.now();
      const nextRound = state.repairRounds + 1;
      let snapshotRef: string | undefined;
      try {
        const snap = await createStepSnapshot(
          this.workspaceRoot,
          this.missionId,
          ++this.snapshotSeq
        );
        if (snap?.ref) {
          snapshotRef = snap.ref;
        }
      } catch (err) {
        console.error(`Snapshot failed before repair node in mission ${this.missionId}:`, err);
      }

      await this.appendAndPublish(
        MISSION_EVENT.NODE_STARTED,
        {
          missionId: this.missionId,
          node: "repair",
          attempt: nextRound,
          ...(snapshotRef ? { snapshot: snapshotRef } : {}),
        },
        "repair"
      );

      await this.appendAndPublish(
        MISSION_EVENT.NODE_COMPLETED,
        { missionId: this.missionId, node: "repair", durationMs: Date.now() - start },
        "repair"
      );

      return { repairRounds: nextRound };
    });

    // 5. review node
    graph.addNode("review", async (state) => {
      if (this.abortController.signal.aborted) return;
      this.currentNode = "review";
      const start = Date.now();
      const attempt = state.repairRounds + 1;

      // The reviewer must see the target's result, not the untouched local tree.
      await this.prepareWorkspace();

      await this.appendAndPublish(
        MISSION_EVENT.NODE_STARTED,
        { missionId: this.missionId, node: "review", attempt },
        "review"
      );

      let diffStr = "";
      try {
        const curTree = this.preparedTree
          ? { available: true, tree: this.preparedTree }
          : await treeOf(state.workspaceRoot);
        if (curTree.available && curTree.tree && state.baseTree) {
          diffStr = `diff ${state.baseTree} -> ${curTree.tree}`;
        }
      } catch {
        // diff not available
      }

      const reviewRes = await this.agent.review(
        {
          goal: state.initialQuery,
          // The diff text comes from the workspace: it must not be able to forge a tag.
          diff: escapeUntrustedText(diffStr),
          check: {
            exitCode: state.lastCheck?.exitCode ?? null,
            outputTail: wrapUntrusted(state.lastCheck?.outputTail ?? "", { source: "command", origin: "check" }),
            passed: state.lastCheck?.passed ?? false,
          },
        },
        {
          workspaceRoot: state.workspaceRoot,
          missionId: state.missionId,
          workspace: this.workspace,
        }
      );

      await this.appendAndPublish(
        MISSION_EVENT.REVIEW_COMPLETED,
        {
          missionId: this.missionId,
          node: "review",
          accept: reviewRes.accept,
          note: reviewRes.note,
          durationMs: Date.now() - start,
        },
        "review"
      );

      await this.appendAndPublish(
        MISSION_EVENT.NODE_COMPLETED,
        {
          missionId: this.missionId,
          node: "review",
          durationMs: Date.now() - start,
        },
        "review"
      );

      return { lastReview: reviewRes };
    });

    // 6. receipt node
    graph.addNode("receipt", async (state) => {
      if (this.abortController.signal.aborted) return;
      this.currentNode = "receipt";
      const start = Date.now();
      await this.appendAndPublish(
        MISSION_EVENT.NODE_STARTED,
        { missionId: this.missionId, node: "receipt", attempt: 1 },
        "receipt"
      );

      // Only after acceptance: SSH writes the user's workspace here. A conflict
      // or a failed fetch/apply leaves the local tree untouched and fails the mission.
      if (this.workspace.kind !== "local") {
        try {
          const applied: WorkspaceResult = await this.workspace.apply();
          if (this.workspace.kind === "ssh" && applied.applied !== true) {
            state.failedReason = { code: 4003, message: "target-apply-failed", node: "receipt" };
            await this.emitTarget("failed", applied.detail ?? "apply did not write the workspace", { result: "failed" });
          } else {
            await this.emitTarget("apply", applied.detail, { result: "applied" });
          }
        } catch (err: any) {
          const conflict = err?.name === "TargetApplyConflictError" || err?.constructor?.name === "TargetApplyConflictError";
          const reason = conflict ? "target-apply-conflict" : "target-apply-failed";
          state.failedReason = { code: 4003, message: reason, node: "receipt" };
          await this.emitTarget(conflict ? "conflict" : "failed", err?.message, { result: conflict ? "conflict" : "failed" });
        }
      }

      const { finalTree, changes } = await this.snapshot(state.baseTree, this.preparedTree);

      await this.appendAndPublish(
        MISSION_EVENT.NODE_COMPLETED,
        { missionId: this.missionId, node: "receipt", durationMs: Date.now() - start },
        "receipt"
      );

      return { finalTree, changes };
    });

    // Edges
    graph.addEdge(START, "plan");
    if (this.options.tournament) {
      graph.addEdge("plan", "tournament");
      graph.addEdge("tournament", "check");
    } else {
      graph.addEdge("plan", "act");
      graph.addEdge("act", "check");
    }

    graph.addConditionalEdges("check", (state) => {
      if (this.abortController.signal.aborted) return END;

      if (state.lastCheck?.passed) {
        return "review";
      }

      // Check budget
      const elapsed = Date.now() - this.startTime;
      if (
        state.repairRounds >= this.budget.maxRepairs ||
        (this.budget.wallClockMs !== undefined && elapsed >= this.budget.wallClockMs)
      ) {
        state.failedReason = { code: 4003, message: "budget exceeded", node: "check" };
        return END;
      }

      state.lastFailure = {
        exitCode: state.lastCheck?.exitCode ?? 1,
        outputTail: state.lastCheck?.outputTail ?? "",
      };
      return "repair";
    });

    graph.addEdge("repair", "act");

    graph.addConditionalEdges("review", (state) => {
      if (this.abortController.signal.aborted) return END;

      if (state.lastReview?.accept) {
        return "receipt";
      }

      // Review rejected
      const elapsed = Date.now() - this.startTime;
      if (
        state.repairRounds >= this.budget.maxRepairs ||
        (this.budget.wallClockMs !== undefined && elapsed >= this.budget.wallClockMs)
      ) {
        state.failedReason = { code: 4003, message: "budget exceeded", node: "review" };
        return END;
      }

      state.lastFailure = {
        exitCode: 0,
        outputTail: `Review rejected: ${state.lastReview?.note ?? "not accepted"}`,
      };
      return "repair";
    });

    graph.addEdge("receipt", END);

    const compiled = graph.compile({ maxIterations: 50 });

    let finalState: MissionState;
    let graphError: string | undefined;
    try {
      const result = await compiled.invoke({
        missionId: this.missionId,
        workspaceRoot: this.workspaceRoot,
        initialQuery: this.initialQuery,
        checkCommand: this.checkCommand,
        title: this.title,
        baseTree,
        plan: [],
        repairRounds: 0,
        checks: [],
      });
      finalState = result.finalState;
      graphError = result.error;
    } catch (err: any) {
      await this.appendAndPublish(MISSION_EVENT.FAILED, {
        missionId: this.missionId,
        error: { code: -32603, message: err?.message ?? "execution failed" },
        node: "runner",
      });
      return;
    }

    // A mission that ends before review (failed check, cancel) still owes the
    // receipt the target's tree; prepare is idempotent and a no-op for local.
    await this.prepareWorkspace().catch(() => undefined);
    const events = await new EventLogReader(this.writer.path).readAll();
    let changes = finalState.changes;
    let finalTree = finalState.finalTree;
    if (!changes) {
      const snap = await this.snapshot(baseTree, this.preparedTree);
      changes = snap.changes;
      finalTree = snap.finalTree ?? finalTree;
    }
    const receipt = projectReceipt(events, changes);
    // Recorded so a viewer can re-run `git diff <base> <final>`; pinned under a ref so gc keeps them.
    const trees = await pinTrees(this.workspaceRoot, this.missionId, baseTree, finalTree);

    if (this.abortController.signal.aborted) {
      await this.appendAndPublish(MISSION_EVENT.STOPPED, {
        missionId: this.missionId,
        reason: "cancelled",
        receipt,
        changes,
        ...trees,
      });
      return;
    }

    // Only the harness decides verified: the receipt rule, never the agent's claim.
    if (receipt.status === "VERIFIED") {
      await this.appendAndPublish(MISSION_EVENT.VERIFIED, {
        missionId: this.missionId,
        receipt,
        changes,
        ...trees,
        totalCostUsd: 0,
      });
      return;
    }

    const reason = finalState.failedReason ?? {
      code: graphError ? -32603 : 4003,
      message: graphError ?? "check did not pass",
      node: graphError ? this.currentNode : "check",
    };

    await this.appendAndPublish(MISSION_EVENT.FAILED, {
      missionId: this.missionId,
      error: { code: reason.code, message: reason.message },
      node: reason.node,
      receipt,
      changes,
      ...trees,
    });
  }
}
