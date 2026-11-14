import { MISSION_EVENT } from "./mission-events.js";
import type { MissionStatus } from "./mission-events.js";

/**
 * The one event→status projection. The engine's projectMission and the desktop mission
 * list both fold a mission log through this, so the two cannot drift. Event kinds that
 * do not move the status (node.*, check.completed, review.completed) return `current`.
 */
export function nextMissionStatus(current: MissionStatus, kind: string): MissionStatus {
  switch (kind) {
    case MISSION_EVENT.STARTED:
    case MISSION_EVENT.ANSWERED:
      return "running";
    case MISSION_EVENT.NEEDS_YOU:
      return "needs-you";
    case MISSION_EVENT.VERIFIED:
      return "verified";
    case MISSION_EVENT.FAILED:
      return "failed";
    case MISSION_EVENT.STOPPED:
      return "stopped";
    default:
      return current;
  }
}

/** Status of a mission log: "running" until an event says otherwise. */
export function projectMissionStatus(events: ReadonlyArray<{ kind: string }>): MissionStatus {
  let status: MissionStatus = "running";
  for (const ev of events) status = nextMissionStatus(status, ev.kind);
  return status;
}
