import * as fsSync from "node:fs";
import * as path from "node:path";
import { EventLogReader, EventLogWriter, FolderTrustStore, GrantsStore, MISSION_EVENT } from "@opensand/shared";
import { randomUUID } from "node:crypto";
import {
  type EventFrame,
  type RestoreSnapshotParams,
  type RestoreSnapshotResult,
  type PreviewRestoreParams,
  type PreviewRestoreResult,
  type TimelineGetParams,
  type TimelineGetResult,
  type TimelineForkParams,
  type TimelineForkResult,
  ErrorCodes,
  OspError,
} from "@opensand/protocol";
import { runCommandOperation } from "@opensand/local-exec-daemon";
import { projectTimelineSteps } from "./timeline.js";
import { logDirFor } from "../reconnect.js";
import { MissionRunner, type MissionOptions } from "./runner.js";
import { projectMission, type MissionProjection } from "./receipt.js";
import type { MissionAgent } from "./agent.js";
import { FolderTrustGate } from "./trust-gate.js";
import { restoreSnapshot, previewRestore, sanitizeRefName, resolveAndValidateRestoreTarget, treeOf, cleanGitEnv, type RestoreExecutionSummary } from "./workspace-diff.js";

export class MissionRunnerManager {
  private activeRunners = new Map<string, MissionRunner>();
  /** Each runner's full run (including its final event writes), so shutdown can wait for it. */
  private settled = new Map<string, Promise<void>>();
  /** Set once shutdown begins: a start that lands after stopAll() took its snapshot would write into a removed state dir. */
  private stopping = false;
  private restoringWorkspaces = new Set<string>();

  constructor(
    private readonly stateDir: string,
    private readonly agent: MissionAgent | undefined,
    private readonly publishFrame: (frame: EventFrame) => void,
    options: { baseDir?: string; gate?: FolderTrustGate; grants?: GrantsStore } = {}
  ) {
    this.grants = options.grants ?? new GrantsStore({ baseDir: options.baseDir ?? stateDir, updatedBy: "engine:missions" });
    this.gate =
      options.gate ??
      new FolderTrustGate(new FolderTrustStore({ baseDir: this.grants.baseDir, grants: this.grants }), this.grants);
  }

  readonly gate: FolderTrustGate;
  private readonly grants: GrantsStore;

  hasAgent(): boolean {
    return this.agent !== undefined;
  }

  activeCount(): number {
    return this.activeRunners.size;
  }

  async startMission(options: MissionOptions): Promise<void> {
    if (!this.agent) {
      throw new Error("no mission agent configured");
    }
    if (this.stopping) {
      throw new Error("engine is shutting down");
    }

    const runner = new MissionRunner(options, {
      stateDir: this.stateDir,
      agent: this.agent,
      gate: this.gate,
      grants: this.grants,
      publish: this.publishFrame,
    });

    this.activeRunners.set(options.missionId, runner);

    // Run in background and clean up when finished
    const run = runner
      .start()
      .catch(() => undefined)
      .finally(() => {
        this.activeRunners.delete(options.missionId);
        this.settled.delete(options.missionId);
      });
    this.settled.set(options.missionId, run);
  }

  async cancelMission(missionId: string): Promise<void> {
    const runner = this.activeRunners.get(missionId);
    if (runner) {
      runner.cancel();
    }
  }

  async getMission(
    missionId: string,
    stateDir: string
  ): Promise<MissionProjection | null> {
    let dir: string;
    try {
      dir = logDirFor(stateDir, "mission", missionId);
    } catch {
      return null;
    }

    if (!fsSync.existsSync(dir)) {
      return null;
    }

    try {
      const reader = new EventLogReader(dir);
      const { events } = await reader.readWithRecovery();
      if (events.length === 0) return null;
      return projectMission(events);
    } catch {
      return null;
    }
  }

  async listMissions(
    stateDir: string,
    statusFilter?: string[]
  ): Promise<Array<{ missionId: string; title: string; status: string; updatedAt: string }>> {
    const missionsDir = path.join(stateDir, "missions");
    if (!fsSync.existsSync(missionsDir)) {
      return [];
    }

    const entries = fsSync.readdirSync(missionsDir, { withFileTypes: true });
    const results: Array<{ missionId: string; title: string; status: string; updatedAt: string }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const missionId = entry.name;
      const proj = await this.getMission(missionId, stateDir);
      if (!proj) continue;

      if (!statusFilter || statusFilter.length === 0 || statusFilter.includes(proj.status)) {
        results.push({
          missionId: proj.missionId,
          title: proj.title,
          status: proj.status,
          updatedAt: proj.updatedAt,
        });
      }
    }

    return results;
  }

  async getCurrentSeq(missionId: string, stateDir: string): Promise<number> {
    let dir: string;
    try {
      dir = logDirFor(stateDir, "mission", missionId);
    } catch {
      return 0;
    }

    if (!fsSync.existsSync(dir)) {
      return 0;
    }

    try {
      const reader = new EventLogReader(dir);
      const { events } = await reader.readWithRecovery();
      return events.length > 0 ? events[events.length - 1].seq : 0;
    } catch {
      return 0;
    }
  }


  isWorkspaceActive(workspaceRoot: string): { active: boolean; missionId?: string } {
    const canon = path.resolve(workspaceRoot);
    for (const [id, runner] of this.activeRunners.entries()) {
      if (path.resolve(runner.workspaceRoot) === canon) {
        return { active: true, missionId: id };
      }
    }
    return { active: false };
  }

  private async resolveAndValidateRestoreParams(
    params: { missionId: string; snapshot: string | number; workspaceRoot?: string },
    stateDir: string
  ): Promise<{ workspaceRoot: string; cleanMission: string }> {
    const cleanMission = sanitizeRefName(params.missionId);

    // Resolve workspaceRoot: either passed explicitly or read from mission log
    let workspaceRoot = params.workspaceRoot;
    if (!workspaceRoot) {
      try {
        const dir = logDirFor(stateDir, "mission", params.missionId);
        if (fsSync.existsSync(dir)) {
          const reader = new EventLogReader(dir);
          const { events } = await reader.readWithRecovery();
          const startEv = events.find((e) => e.kind === MISSION_EVENT.STARTED);
          if (startEv?.data?.workspaceRoot && typeof startEv.data.workspaceRoot === "string") {
            workspaceRoot = startEv.data.workspaceRoot;
          }
        }
      } catch {}
    }

    if (!workspaceRoot) {
      throw new OspError(ErrorCodes.InvalidParams, "workspaceRoot is required");
    }

    // Risk 4: Fail-fast active mission check
    const active = this.isWorkspaceActive(workspaceRoot);
    if (active.active) {
      throw new OspError(
        ErrorCodes.InvalidRequest,
        `Cannot restore workspace while mission '${active.missionId}' is actively running. Stop or wait for the mission to complete before restoring.`
      );
    }

    // Risk 7: Folder Trust gate
    const trusted = await this.gate.isFolderTrusted(workspaceRoot);
    if (!trusted) {
      throw new OspError(ErrorCodes.InvalidRequest, "Workspace folder is untrusted");
    }

    // Risk 7: Mission Ref Confinement
    const snapStr = String(params.snapshot).trim();
    if (snapStr.startsWith("refs/opensand/missions/")) {
      const expectedPrefix = `refs/opensand/missions/${cleanMission}/`;
      if (!snapStr.startsWith(expectedPrefix)) {
        throw new OspError(ErrorCodes.InvalidParams, `Ref does not belong to mission ${params.missionId}`);
      }
    }

    return { workspaceRoot, cleanMission };
  }

  async previewRestore(
    params: PreviewRestoreParams,
    stateDir: string
  ): Promise<PreviewRestoreResult> {
    const { workspaceRoot } = await this.resolveAndValidateRestoreParams(params, stateDir);

    const summary = await previewRestore(workspaceRoot, params.missionId, params.snapshot);

    return {
      success: true,
      missionId: params.missionId,
      targetRef: summary.targetRef,
      targetTree: summary.targetTree,
      restoredFilesCount: summary.restoredFiles.length,
      deletedFilesCount: summary.deletedFiles.length,
      restoredFiles: summary.restoredFiles,
      overwrittenFiles: summary.overwrittenFiles,
      deletedFiles: summary.deletedFiles,
      skippedSubmodules: summary.skippedSubmodules,
    };
  }

  async restoreSnapshot(
    params: RestoreSnapshotParams,
    stateDir: string
  ): Promise<RestoreSnapshotResult> {
    const { workspaceRoot } = await this.resolveAndValidateRestoreParams(params, stateDir);

    // Concurrency lock per workspace
    const canonRoot = path.resolve(workspaceRoot);
    if (this.restoringWorkspaces.has(canonRoot)) {
      throw new OspError(ErrorCodes.InvalidRequest, `A restore is already in progress on workspace ${workspaceRoot}`);
    }
    this.restoringWorkspaces.add(canonRoot);

    try {
      const summary = await restoreSnapshot(workspaceRoot, params.missionId, params.snapshot);

      // Append SNAPSHOT_RESTORED event to mission log
      const dir = logDirFor(stateDir, "mission", params.missionId);
      if (fsSync.existsSync(dir)) {
        try {
          const writer = new EventLogWriter(dir, { sessionId: params.missionId });
          await writer.append({
            sessionId: params.missionId,
            kind: MISSION_EVENT.SNAPSHOT_RESTORED,
            data: {
              missionId: params.missionId,
              restoredSnapshot: summary.restoredSnapshot,
              preRestoreSnapshot: summary.preRestoreSnapshot,
              targetTree: summary.targetTree,
              timestamp: new Date().toISOString(),
            },
          });
        } catch (err) {
          console.warn(`Failed to append SNAPSHOT_RESTORED event:`, err);
        }
      }

      return {
        success: true,
        missionId: params.missionId,
        restoredSnapshot: summary.restoredSnapshot,
        preRestoreSnapshot: summary.preRestoreSnapshot,
        targetTree: summary.targetTree,
        restoredFilesCount: summary.restoredFilesCount,
        deletedFilesCount: summary.deletedFilesCount,
        restoredFiles: summary.restoredFiles,
        overwrittenFiles: summary.overwrittenFiles,
        deletedFiles: summary.deletedFiles,
        skippedSubmodules: summary.skippedSubmodules,
      };
    } finally {
      this.restoringWorkspaces.delete(canonRoot);
    }
  }


  async timelineGet(
    params: TimelineGetParams,
    stateDir: string
  ): Promise<TimelineGetResult> {
    if (!params || typeof params.missionId !== "string" || !params.missionId.trim()) {
      throw new OspError(ErrorCodes.InvalidParams, "missionId is required");
    }

    const cleanMission = sanitizeRefName(params.missionId);
    if (!cleanMission || cleanMission !== params.missionId || params.missionId.includes("..")) {
      throw new OspError(ErrorCodes.InvalidParams, `Invalid mission id: ${params.missionId}`);
    }

    let dir: string;
    try {
      dir = logDirFor(stateDir, "mission", params.missionId);
    } catch {
      throw new OspError(ErrorCodes.InvalidParams, `Invalid mission id: ${params.missionId}`);
    }

    if (!fsSync.existsSync(dir)) {
      throw new OspError(ErrorCodes.InvalidParams, `Mission not found: ${params.missionId}`);
    }

    try {
      const reader = new EventLogReader(dir);
      const { events } = await reader.readWithRecovery();
      const steps = projectTimelineSteps(events);
      return {
        missionId: params.missionId,
        steps,
      };
    } catch (err: any) {
      if (err instanceof OspError) throw err;
      throw new OspError(ErrorCodes.InvalidParams, `Failed to read timeline for mission ${params.missionId}: ${err.message}`);
    }
  }

  async fork(
    params: TimelineForkParams,
    stateDir: string,
    options?: { _simulateFailure?: "checkout" | "unlink" }
  ): Promise<TimelineForkResult> {
    if (!params || typeof params.missionId !== "string" || !params.missionId.trim()) {
      throw new OspError(ErrorCodes.InvalidParams, "missionId is required");
    }
    if (params.snapshot === undefined || params.snapshot === null || params.snapshot === "") {
      throw new OspError(ErrorCodes.InvalidParams, "snapshot is required");
    }

    const cleanParent = sanitizeRefName(params.missionId);
    if (!cleanParent || cleanParent !== params.missionId || params.missionId.includes("..")) {
      throw new OspError(ErrorCodes.InvalidParams, `Invalid mission id: ${params.missionId}`);
    }

    let parentDir: string;
    try {
      parentDir = logDirFor(stateDir, "mission", params.missionId);
    } catch {
      throw new OspError(ErrorCodes.InvalidParams, `Invalid mission id: ${params.missionId}`);
    }

    if (!fsSync.existsSync(parentDir)) {
      throw new OspError(ErrorCodes.InvalidParams, `Mission not found: ${params.missionId}`);
    }

    const reader = new EventLogReader(parentDir);
    const { events } = await reader.readWithRecovery();
    if (events.length === 0) {
      throw new OspError(ErrorCodes.InvalidParams, `Parent mission ${params.missionId} has no events`);
    }

    const startEv = events.find(
      (e) => e.kind === MISSION_EVENT.STARTED || e.kind === MISSION_EVENT.FORKED
    );
    const parentWorkspaceRoot = startEv?.data?.workspaceRoot as string | undefined;
    const parentTitle = (startEv?.data?.title as string | undefined) ?? "Mission";
    const parentInitialQuery = (startEv?.data?.initialQuery as string | undefined) ?? "";
    const parentCheckCommand = (startEv?.data?.checkCommand as string | undefined) ?? "";
    const parentBudget = (startEv?.data?.budget as any) ?? {
      budgetUsd: startEv?.data?.budgetUsd as number | undefined,
      maxRepairs: startEv?.data?.maxRepairs as number | undefined,
    };

    const workspaceRoot = params.workspaceRoot ?? parentWorkspaceRoot;
    if (!workspaceRoot) {
      throw new OspError(ErrorCodes.InvalidParams, "workspaceRoot is required");
    }

    // Fail-fast active mission check (§4)
    const active = this.isWorkspaceActive(workspaceRoot);
    if (active.active) {
      throw new OspError(
        ErrorCodes.InvalidRequest,
        `Cannot fork workspace while mission \x27${active.missionId}\x27 is actively running. Stop or wait for the mission to complete before forking.`
      );
    }

    // Folder trust gate (§4)
    const trusted = await this.gate.isFolderTrusted(workspaceRoot);
    if (!trusted) {
      throw new OspError(ErrorCodes.InvalidRequest, "Workspace folder is untrusted");
    }

    // Concurrency lock per workspace (§4)
    const canonRoot = path.resolve(workspaceRoot);
    if (this.restoringWorkspaces.has(canonRoot)) {
      throw new OspError(
        ErrorCodes.InvalidRequest,
        `A restore or fork is already in progress on workspace ${workspaceRoot}`
      );
    }

    // Foreign mission ref prefix check (§4)
    const snapStr = String(params.snapshot).trim();
    if (snapStr.startsWith("refs/opensand/missions/")) {
      const expectedPrefix = `refs/opensand/missions/${cleanParent}/`;
      if (!snapStr.startsWith(expectedPrefix)) {
        throw new OspError(ErrorCodes.InvalidParams, `Ref does not belong to mission ${params.missionId}`);
      }
    }

    // Target validation and tree safety check
    const resolved = await resolveAndValidateRestoreTarget(workspaceRoot, params.missionId, params.snapshot);

    // No-op fork check (§4)
    const currentTreeRes = await treeOf(workspaceRoot);
    if (currentTreeRes.available && currentTreeRes.tree === resolved.targetTree) {
      throw new OspError(
        ErrorCodes.InvalidRequest,
        "No-op fork: workspace is already at the target snapshot"
      );
    }

    // Restore under concurrency lock
    this.restoringWorkspaces.add(canonRoot);
    let summary: RestoreExecutionSummary;
    try {
      summary = await restoreSnapshot(workspaceRoot, params.missionId, params.snapshot, options);
    } finally {
      this.restoringWorkspaces.delete(canonRoot);
    }

    // Identity and inheritance (§3)
    const newMissionId = `m-${randomUUID().slice(0, 8)}`;
    const cleanNewMissionId = sanitizeRefName(newMissionId);
    const newTitle = params.newTitle ?? `${parentTitle} (fork)`;
    const newInstruction = params.newInstruction ?? parentInitialQuery;
    const checkCommand = parentCheckCommand;
    const budget = {
      budgetUsd: typeof params.budgetUsd === "number" ? params.budgetUsd : (parentBudget?.budgetUsd ?? undefined),
      maxRepairs: typeof params.maxRepairs === "number" ? params.maxRepairs : (parentBudget?.maxRepairs ?? 3),
    };

    // Pin base tree and lineage fork-parent ref (§2)
    await runCommandOperation({
      command: `git update-ref refs/opensand/missions/${cleanNewMissionId}/base ${resolved.targetTree}`,
      cwd: workspaceRoot,
      workspaceRoot,
      env: cleanGitEnv(),
    });
    await runCommandOperation({
      command: `git update-ref refs/opensand/missions/${cleanNewMissionId}/fork-parent "${resolved.targetRef}"`,
      cwd: workspaceRoot,
      workspaceRoot,
      env: cleanGitEnv(),
    });

    // Write initial MISSION_FORKED event to new mission log (§3)
    const newMissionDir = logDirFor(stateDir, "mission", newMissionId);
    const writer = new EventLogWriter(newMissionDir, { sessionId: newMissionId });
    await writer.append({
      sessionId: newMissionId,
      kind: MISSION_EVENT.FORKED,
      data: {
        missionId: newMissionId,
        forkedFrom: {
          missionId: params.missionId,
          snapshot: resolved.targetRef,
          targetTree: resolved.targetTree,
        },
        workspaceRoot,
        title: newTitle,
        initialQuery: newInstruction,
        checkCommand,
        budget,
        timestamp: new Date().toISOString(),
      },
    });

    // If agent configured, start runner
    if (this.hasAgent()) {
      try {
        await this.startMission({
          missionId: newMissionId,
          workspaceRoot,
          title: newTitle,
          initialQuery: newInstruction,
          checkCommand,
          budget,
          forkedFrom: {
            missionId: params.missionId,
            snapshot: resolved.targetRef,
            targetTree: resolved.targetTree,
          },
        });
      } catch (err: any) {
        try {
          fsSync.rmSync(newMissionDir, { recursive: true, force: true });
        } catch {}
        throw new OspError(
          ErrorCodes.InternalError,
          `Failed to start mission runner for fork: ${err.message}. Pre-restore snapshot pinned at ${summary.preRestoreSnapshot}`,
          { preRestoreSnapshot: summary.preRestoreSnapshot }
        );
      }
    }

    return {
      success: true,
      newMissionId,
      forkedFrom: {
        missionId: params.missionId,
        snapshot: resolved.targetRef,
        targetTree: resolved.targetTree,
      },
      restoredFilesCount: summary.restoredFilesCount,
      deletedFilesCount: summary.deletedFilesCount,
      preRestoreSnapshot: summary.preRestoreSnapshot,
    };
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    for (const runner of this.activeRunners.values()) {
      runner.cancel();
    }
    // A cancelled runner still appends its STOPPED event; wait for that write before returning.
    await Promise.allSettled([...this.settled.values()]);
    this.activeRunners.clear();
  }
}
