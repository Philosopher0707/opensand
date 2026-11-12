import { ErrorCodes, OspError, encodeLine } from "@opensand/protocol";
import { replayFrom } from "../reconnect.js";
import type { Handler } from "../types.js";

export function createEngineHandlers(): Record<string, Handler> {
  return {
    "engine.Engine.ping": (_params, context) => ({
      timestamp: context.now().toISOString(),
    }),

    "engine.Engine.status": (_params, context) => ({
      version: context.version,
      pid: context.pid,
      activeMissions: context.activeMissions(),
      uptimeMs: Math.max(0, context.now().getTime() - context.startedAt),
    }),

    "engine.Engine.shutdown": (params, context) => {
      context.requestShutdown(params.force === true);
      return { success: true };
    },

    "engine.Engine.reconnect": async (params, context) => {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      const missionId = typeof params.missionId === "string" ? params.missionId : undefined;
      if ((sessionId === undefined) === (missionId === undefined)) {
        throw new OspError(
          ErrorCodes.InvalidParams,
          "exactly one of sessionId or missionId is required"
        );
      }
      const lastSeq = params.lastSeq;
      if (typeof lastSeq !== "number" || !Number.isInteger(lastSeq) || lastSeq < 0) {
        throw new OspError(ErrorCodes.InvalidParams, "lastSeq must be a non-negative integer");
      }

      const { frames, currentSeq } = await replayFrom(
        context.stateDir,
        sessionId === undefined ? "mission" : "session",
        (sessionId ?? missionId) as string,
        lastSeq
      );

      for (const frame of frames) {
        await context.connection.write(encodeLine(frame));
      }
      context.subscribe(context.connection);
      return { replayedEvents: frames.length, currentSeq };
    },

    "mission.Missions.subscribe": (_params, context) => {
      context.subscribe(context.connection);
      return { subscribed: true };
    },

    "inbox.Approvals.subscribe": (_params, context) => {
      context.subscribe(context.connection);
      return { subscribed: true };
    },
  };
}
