/**
 * Mission event kinds and statuses recorded to the event log and broadcast over OSP.
 */

export const MISSION_EVENT = {
  STARTED: "mission.started",
  NODE_STARTED: "node.started",
  NODE_COMPLETED: "node.completed",
  CHECK_COMPLETED: "check.completed",
  REVIEW_COMPLETED: "review.completed",
  VERIFIED: "mission.verified",
  FAILED: "mission.failed",
  STOPPED: "mission.stopped",
  NEEDS_YOU: "mission.needs-you",
  ANSWERED: "mission.answered",
  SNAPSHOT_RESTORED: "snapshot.restored",
} as const;

export type MissionEventKind = (typeof MISSION_EVENT)[keyof typeof MISSION_EVENT];

export type MissionStatus =
  | "planned"
  | "running"
  | "needs-you"
  | "verified"
  | "failed"
  | "stopped";

export interface NodeStartedPayload {
  missionId: string;
  node: string;
  attempt?: number;
  snapshot?: string;
  [key: string]: unknown;
}

export interface SnapshotRestoredPayload {
  missionId: string;
  restoredSnapshot: string;
  preRestoreSnapshot: string;
  targetTree: string;
  timestamp: string;
}
