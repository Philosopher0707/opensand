import { ErrorCodes, OspError } from "@opensand/protocol";
import type { Handler } from "../types.js";
import type { MissionRunnerManager } from "../missions/manager.js";

export function createTimelineHandlers(manager: MissionRunnerManager): Record<string, Handler> {
  return {
    "timeline.Timeline.get": async (params, context) => {
      const missionId = typeof params?.missionId === "string" ? params.missionId : undefined;
      if (!missionId) {
        throw new OspError(ErrorCodes.InvalidParams, "missionId is required");
      }
      return manager.timelineGet({ missionId }, context.stateDir);
    },
    "timeline.Timeline.fork": async (params, context) => {
      const missionId = typeof params?.missionId === "string" ? params.missionId : undefined;
      if (!missionId) {
        throw new OspError(ErrorCodes.InvalidParams, "missionId is required");
      }
      if (params.snapshot === undefined || params.snapshot === null || params.snapshot === "") {
        throw new OspError(ErrorCodes.InvalidParams, "snapshot is required");
      }

      const workspaceRoot = typeof params.workspaceRoot === "string" ? params.workspaceRoot : undefined;
      const newInstruction = typeof params.newInstruction === "string" ? params.newInstruction : undefined;
      const newTitle = typeof params.newTitle === "string" ? params.newTitle : undefined;
      const budgetUsd = typeof params.budgetUsd === "number" ? params.budgetUsd : undefined;
      const maxRepairs = typeof params.maxRepairs === "number" ? params.maxRepairs : undefined;

      return manager.fork(
        {
          missionId,
          snapshot: params.snapshot as string | number,
          workspaceRoot,
          newInstruction,
          newTitle,
          budgetUsd,
          maxRepairs,
        },
        context.stateDir
      );
    },
  };
}
