export const METHODS = [
  "engine.Engine.ping",
  "engine.Engine.status",
  "engine.Engine.reconnect",
  "engine.Engine.shutdown",
  "mission.Missions.start",
  "mission.Missions.get",
  "mission.Missions.list",
  "mission.Missions.pause",
  "mission.Missions.resume",
  "mission.Missions.cancel",
  "mission.Missions.subscribe",
  "inbox.Approvals.list",
  "inbox.Approvals.answer",
  "inbox.Approvals.subscribe",
  "timeline.Timeline.get",
  "timeline.Timeline.restore",
  "timeline.Timeline.fork",
  "session.Sessions.create",
  "session.Sessions.get",
  "session.Sessions.list",
  "session.Sessions.rename",
  "session.Sessions.delete",
] as const;

export const EVENTS = [
  "mission.Missions.started",
  "mission.Missions.nodeStarted",
  "mission.Missions.nodeCompleted",
  "mission.Missions.toolStarted",
  "mission.Missions.toolCompleted",
  "mission.Missions.checkCompleted",
  "mission.Missions.paused",
  "mission.Missions.resumed",
  "mission.Missions.completed",
  "mission.Missions.failed",
  "inbox.Approvals.requested",
  "inbox.Approvals.resolved",
  "session.Sessions.messageAppended",
  "engine.Engine.heartbeat",
] as const;

export type MethodName = (typeof METHODS)[number];
export type EventName = (typeof EVENTS)[number];

const NAME_PATTERN = /^[a-z]+\.[A-Z][A-Za-z]*\.[a-z][A-Za-z]*$/;
const KNOWN_METHODS: ReadonlySet<string> = new Set(METHODS);

export function isWellFormedName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export function isKnownMethod(name: string): name is MethodName {
  return KNOWN_METHODS.has(name);
}
