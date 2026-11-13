import * as fsSync from "node:fs";
import * as path from "node:path";
import { EventLogReader } from "@opensand/shared";
import type { EventFrame } from "@opensand/protocol";
import { logDirFor } from "../reconnect.js";
import { MissionRunner, type MissionOptions } from "./runner.js";
import { projectMission, type MissionProjection } from "./receipt.js";
import type { MissionAgent } from "./agent.js";

export class MissionRunnerManager {
  private activeRunners = new Map<string, MissionRunner>();

  constructor(
    private readonly stateDir: string,
    private readonly agent: MissionAgent | undefined,
    private readonly publishFrame: (frame: EventFrame) => void
  ) {}

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
      publish: this.publishFrame,
    });

    this.activeRunners.set(options.missionId, runner);

    // Run in background and clean up when finished
    void runner
      .start()
      .catch(() => undefined)
      .finally(() => {
        this.activeRunners.delete(options.missionId);
      });
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
    this.activeRunners.clear();
  }
}
