import { START, END, StateGraph } from "@opensand/shared";
import { EventLogWriter, EventLogReader } from "@opensand/shared";
import { wrapUntrusted } from "@opensand/shared";
import { MISSION_EVENT, FolderTrustStore, GrantsStore, resolveSandboxProfile } from "@opensand/shared";
import type { EventFrame } from "@opensand/protocol";
import { logDirFor, eventNameForKind } from "../reconnect.js";
import { runCheck, type CheckResult } from "./check.js";
import { treeOf, changedLinesBetweenTrees, type ChangesResult } from "./workspace-diff.js";
import { projectReceipt } from "./receipt.js";
import type { MissionAgent } from "./agent.js";
import type { FolderTrustGate } from "./trust-gate.js";

export interface MissionBudget {
  maxRepairs: number;
  wallClockMs?: number;
  budgetUsd?: number;
}

export interface MissionOptions {
  missionId: string;
  workspaceRoot: string;
  title: string;
  initialQuery: string;
  checkCommand: string;
  budget?: Partial<MissionBudget>;
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

  /**
   * Tree of the workspace as it is now, plus the changed lines against the
   * base tree. Never touches the user's index, branch or stash.
   */
  private async snapshot(
    baseTree: string | undefined
  ): Promise<{ finalTree?: string; changes: ChangesResult }> {
    try {
      const finalRes = await treeOf(this.workspaceRoot);
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

  private async run(): Promise<void> {
    // Log-only; no command runs before the folder-trust gate below.
    await this.appendAndPublish(MISSION_EVENT.STARTED, {
      missionId: this.missionId,
      title: this.title,
      workspaceRoot: this.workspaceRoot,
      budgetUsd: this.budget.budgetUsd ?? 0,
    });

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
      await this.appendAndPublish(
        MISSION_EVENT.NODE_STARTED,
        { missionId: this.missionId, node: "act", attempt },
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
        { signal: this.abortController.signal }
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

      await this.appendAndPublish(
        MISSION_EVENT.NODE_STARTED,
        { missionId: this.missionId, node: "repair", attempt: nextRound },
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

      await this.appendAndPublish(
        MISSION_EVENT.NODE_STARTED,
        { missionId: this.missionId, node: "review", attempt },
        "review"
      );

      let diffStr = "";
      try {
        const curTree = await treeOf(state.workspaceRoot);
        if (curTree.available && curTree.tree && state.baseTree) {
          diffStr = `diff ${state.baseTree} -> ${curTree.tree}`;
        }
      } catch {
        // diff not available
      }

      const reviewRes = await this.agent.review(
        {
          goal: state.initialQuery,
          diff: diffStr,
          check: {
            exitCode: state.lastCheck?.exitCode ?? null,
            outputTail: wrapUntrusted(state.lastCheck?.outputTail ?? "", { source: "command", origin: "check" }),
            passed: state.lastCheck?.passed ?? false,
          },
        },
        {
          workspaceRoot: state.workspaceRoot,
          missionId: state.missionId,
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

      const { finalTree, changes } = await this.snapshot(state.baseTree);

      await this.appendAndPublish(
        MISSION_EVENT.NODE_COMPLETED,
        { missionId: this.missionId, node: "receipt", durationMs: Date.now() - start },
        "receipt"
      );

      return { finalTree, changes };
    });

    // Edges
    graph.addEdge(START, "plan");
    graph.addEdge("plan", "act");
    graph.addEdge("act", "check");

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

    const events = await new EventLogReader(this.writer.path).readAll();
    const changes = finalState.changes ?? (await this.snapshot(baseTree)).changes;
    const receipt = projectReceipt(events, changes);

    if (this.abortController.signal.aborted) {
      await this.appendAndPublish(MISSION_EVENT.STOPPED, {
        missionId: this.missionId,
        reason: "cancelled",
        receipt,
        changes,
      });
      return;
    }

    // Only the harness decides verified: the receipt rule, never the agent's claim.
    if (receipt.status === "VERIFIED") {
      await this.appendAndPublish(MISSION_EVENT.VERIFIED, {
        missionId: this.missionId,
        receipt,
        changes,
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
    });
  }
}
