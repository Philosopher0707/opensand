import { createTimelineHandlers, MissionRunnerManager } from "@opensand/engine";
import type { TimelineForkResult } from "./shell/mission-fork-model.js";
import { listMissionSummaries } from "./shell/mission-list-source.js";

export type ForkOptions = {
  newTitle?: string;
  newInstruction?: string;
};

export type ForkFn = (
  missionId: string,
  snapshot: string | number,
  options?: ForkOptions
) => Promise<TimelineForkResult>;

function createForkContext(stateDir: string) {
  return {
    stateDir,
    version: "desktop",
    pid: process.pid,
    startedAt: Date.now(),
    now: () => new Date(),
    connection: { write: async () => undefined, close: () => undefined },
    subscribe: () => undefined,
    requestShutdown: () => undefined,
    activeMissions: () => 0,
    publish: () => undefined,
  };
}

/**
 * The desktop\x27s route to \x60timeline.Timeline.fork\x60. Runs the engine\x27s handler in-process,
 * materializing the step snapshot into the workspace, recording pre-restore safety copy,
 * creating the new mission with inherited configuration, and writing the FORKED log event.
 */
export function createMissionFork(stateDir: string): ForkFn {
  let handler: ((params: Record<string, unknown>, context: any) => Promise<unknown>) | undefined;
  const context = createForkContext(stateDir);
  return async (missionId, snapshot, options) => {
    if (
      typeof missionId !== "string" ||
      missionId === "" ||
      snapshot === undefined ||
      snapshot === null ||
      snapshot === ""
    ) {
      throw new Error("missionId and snapshot are required");
    }
    const summaries = await listMissionSummaries(stateDir);
    if (summaries.find((m) => m.missionId === missionId)?.status === "running") {
      throw new Error(`Cannot fork: mission \x27${missionId}\x27 is actively running`);
    }
    if (!handler) {
      const manager = new MissionRunnerManager(stateDir, undefined, () => undefined);
      handler = createTimelineHandlers(manager)["timeline.Timeline.fork"] as unknown as typeof handler;
    }
    return (await handler!(
      {
        missionId,
        snapshot,
        newTitle: options?.newTitle,
        newInstruction: options?.newInstruction,
      },
      context
    )) as TimelineForkResult;
  };
}
