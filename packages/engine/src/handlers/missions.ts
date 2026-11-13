import { randomUUID } from "node:crypto";
import { ErrorCodes, OspError } from "@opensand/protocol";
import type { Handler } from "../types.js";
import type { MissionRunnerManager } from "../missions/manager.js";

export function createMissionHandlers(manager: MissionRunnerManager): Record<string, Handler> {
  return {
    "mission.Missions.start": async (params, context) => {
      const workspaceRoot = typeof params.workspaceRoot === "string" ? params.workspaceRoot : undefined;
      const title = typeof params.title === "string" ? params.title : undefined;
      const initialQuery = typeof params.initialQuery === "string" ? params.initialQuery : undefined;
      const checkCommand = typeof params.checkCommand === "string" ? params.checkCommand : undefined;

      if (!workspaceRoot) {
        throw new OspError(ErrorCodes.InvalidParams, "workspaceRoot is required");
      }
      if (!title) {
        throw new OspError(ErrorCodes.InvalidParams, "title is required");
      }
      if (!initialQuery) {
        throw new OspError(ErrorCodes.InvalidParams, "initialQuery is required");
      }
      if (!checkCommand) {
        throw new OspError(ErrorCodes.InvalidParams, "checkCommand is required");
      }

      if (!manager.hasAgent()) {
        throw new OspError(ErrorCodes.InvalidRequest, "no mission agent configured");
      }

      const budgetUsd = typeof params.budgetUsd === "number" ? params.budgetUsd : undefined;
      const maxRepairs = typeof params.maxRepairs === "number" ? params.maxRepairs : 3;
      const wallClockMs = typeof params.wallClockMs === "number" ? params.wallClockMs : undefined;

      const missionId = `m-${randomUUID().slice(0, 8)}`;

      await manager.startMission({
        missionId,
        workspaceRoot,
        title,
        initialQuery,
        checkCommand,
        budget: {
          budgetUsd,
          maxRepairs,
          wallClockMs,
        },
      });

      return {
        missionId,
        status: "running",
      };
    },

    "mission.Missions.get": async (params, context) => {
      const missionId = typeof params.missionId === "string" ? params.missionId : undefined;
      if (!missionId) {
        throw new OspError(ErrorCodes.InvalidParams, "missionId is required");
      }

      const proj = await manager.getMission(missionId, context.stateDir);
      if (!proj) {
        throw new OspError(ErrorCodes.InvalidParams, `mission ${missionId} not found`);
      }

      return {
        missionId: proj.missionId,
        status: proj.status,
        title: proj.title,
        currentNode: proj.currentNode,
        budgetSpentUsd: proj.budgetSpentUsd,
        receipt: proj.receipt,
      };
    },

    "mission.Missions.list": async (params, context) => {
      const statusFilter = Array.isArray(params.status) ? (params.status as string[]) : undefined;
      const missions = await manager.listMissions(context.stateDir, statusFilter);
      return { missions };
    },

    "mission.Missions.cancel": async (params) => {
      const missionId = typeof params.missionId === "string" ? params.missionId : undefined;
      if (!missionId) {
        throw new OspError(ErrorCodes.InvalidParams, "missionId is required");
      }
      await manager.cancelMission(missionId);
      return { success: true };
    },

    "mission.Missions.subscribe": async (params, context) => {
      context.subscribe(context.connection);
      const missionId = typeof params.missionId === "string" ? params.missionId : undefined;
      let currentSeq = 0;
      if (missionId) {
        currentSeq = await manager.getCurrentSeq(missionId, context.stateDir);
      }
      return { subscribed: true, currentSeq };
    },

    "mission.Missions.pause": () => {
      throw new OspError(
        ErrorCodes.MethodNotFound,
        "mission pause planned for p3b",
        { planned: "p3b" }
      );
    },

    "mission.Missions.resume": () => {
      throw new OspError(
        ErrorCodes.MethodNotFound,
        "mission resume planned for p3b",
        { planned: "p3b" }
      );
    },
  };
}
