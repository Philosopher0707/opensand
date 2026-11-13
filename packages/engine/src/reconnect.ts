import * as path from "node:path";
import { EventChainIntegrityError, EventLogReader, MISSION_EVENT, type SessionEvent } from "@opensand/shared";
import {
  ErrorCodes,
  EVENTS,
  OspError,
  type EventFrame,
  type EventName,
} from "@opensand/protocol";

export type LogScope = "session" | "mission";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KNOWN_EVENTS: ReadonlySet<string> = new Set(EVENTS);

/**
 * Single place that maps a log scope and id to its directory under the state
 * root. The root is injected so tests never depend on the home directory.
 */
export function logDirFor(stateDir: string, scope: LogScope, id: string): string {
  if (!SAFE_ID.test(id)) {
    throw new OspError(ErrorCodes.InvalidParams, "id must be a plain session or mission name");
  }
  return path.join(stateDir, scope === "session" ? "sessions" : "missions", id);
}

/**
 * Log kinds are not yet one-to-one with OSP event names (the mission runner
 * lands in Phase 3). Known catalog names pass through; anything else becomes a
 * stable `session.Sessions.<camelCase>` name so a client sees one frame per log
 * record instead of none.
 */
const MISSION_EVENT_MAP: Readonly<Record<string, EventName | string>> = {
  [MISSION_EVENT.STARTED]: "mission.Missions.started",
  [MISSION_EVENT.NODE_STARTED]: "mission.Missions.nodeStarted",
  [MISSION_EVENT.NODE_COMPLETED]: "mission.Missions.nodeCompleted",
  [MISSION_EVENT.CHECK_COMPLETED]: "mission.Missions.checkCompleted",
  [MISSION_EVENT.REVIEW_COMPLETED]: "mission.Missions.nodeCompleted",
  [MISSION_EVENT.VERIFIED]: "mission.Missions.completed",
  [MISSION_EVENT.FAILED]: "mission.Missions.failed",
  [MISSION_EVENT.STOPPED]: "mission.Missions.failed",
};

export function eventNameForKind(kind: string): EventName | string {
  if (KNOWN_EVENTS.has(kind)) return kind;
  if (kind in MISSION_EVENT_MAP) return MISSION_EVENT_MAP[kind];
  const words = kind.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const camel = words
    .map((word, index) => (index === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join("");
  return `session.Sessions.${camel || "event"}`;
}

export interface ReplayResult {
  frames: EventFrame[];
  currentSeq: number;
}

/** Replays log records `lastSeq + 1 .. head` in order. */
export async function replayFrom(
  stateDir: string,
  scope: LogScope,
  id: string,
  lastSeq: number
): Promise<ReplayResult> {
  const dir = logDirFor(stateDir, scope, id);

  let events: SessionEvent[];
  try {
    events = (await new EventLogReader(dir).readWithRecovery()).events;
  } catch (err) {
    if (err instanceof EventChainIntegrityError) {
      throw new OspError(ErrorCodes.ChainIntegrityError, err.message, { seq: err.seq });
    }
    throw err;
  }

  const currentSeq = events.length > 0 ? events[events.length - 1].seq : 0;
  if (lastSeq > currentSeq) {
    throw new OspError(
      ErrorCodes.ChainIntegrityError,
      `lastSeq ${lastSeq} is beyond the log head ${currentSeq}`,
      { lastSeq, currentSeq }
    );
  }

  return {
    frames: events.filter((event) => event.seq > lastSeq).map(toEventFrame),
    currentSeq,
  };
}

function toEventFrame(event: SessionEvent): EventFrame {
  const payload =
    event.data && typeof event.data === "object" && !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)
      : { value: event.data };
  return {
    event: eventNameForKind(event.kind),
    seq: event.seq,
    ts: event.ts,
    data: { ...payload, logKind: event.kind },
  };
}
