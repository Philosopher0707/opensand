import * as fsSync from "node:fs";
import * as path from "node:path";
import { EventLogReader, FolderTrustStore, GrantsStore } from "@opensand/shared";
import type { EventFrame } from "@opensand/protocol";
import { logDirFor } from "../reconnect.js";
import { MissionRunner, type MissionOptions } from "./runner.js";
import { projectMission, type MissionProjection } from "./receipt.js";
import type { MissionAgent } from "./agent.js";
import { FolderTrustGate } from "./trust-gate.js";

export class MissionRunnerManager {
  private activeRunners = new Map<string, MissionRunner>();
  /** Each runner's full run (including its final event writes), so shutdown can wait for it. */
  private settled = new Map<string, Promise<void>>();

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

  async stopAll(): Promise<void> {
    for (const runner of this.activeRunners.values()) {
      runner.cancel();
    }
    // A cancelled runner still appends its STOPPED event; wait for that write before returning.
    await Promise.allSettled([...this.settled.values()]);
    this.activeRunners.clear();
  }
}
