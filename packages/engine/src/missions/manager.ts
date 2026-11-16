import * as fsSync from "node:fs";
import * as path from "node:path";
import { EventLogReader, EventLogWriter, FolderTrustStore, GrantsStore, MISSION_EVENT } from "@opensand/shared";
import { type EventFrame, type RestoreSnapshotParams, type RestoreSnapshotResult, type PreviewRestoreParams, type PreviewRestoreResult, ErrorCodes, OspError } from "@opensand/protocol";
import { logDirFor } from "../reconnect.js";
import { MissionRunner, type MissionOptions } from "./runner.js";
import { projectMission, type MissionProjection } from "./receipt.js";
import type { MissionAgent } from "./agent.js";
import { FolderTrustGate } from "./trust-gate.js";
import { restoreSnapshot, previewRestore, sanitizeRefName } from "./workspace-diff.js";

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
