export const GENESIS_PREV_HASH = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

export type EventGraphNode = "plan" | "act" | "check" | "review" | "repair" | "user" | string;

export const EVENT = {
  sessionCreated: "session.created",
  sessionRenamed: "session.renamed",
  snapshot: "session.snapshot",
  system: "session.system",
  turnStarted: "turn.started",
  turnFolded: "turn.folded",
  turnRollback: "turn.rollback",
  turnCompacted: "turn.compacted",
  modelCompletion: "model.completion",
  toolCompleted: "tool.completed",
  restorePoint: "workspace.restorePoint",
  restorePointFailed: "workspace.restorePointFailed",
  restore: "workspace.restore",
} as const;

export type EventKind =
  | "session.created"
  | "session.renamed"
  | "session.deleted"
  | "session.system"
  | "turn.started"
  | "turn.completed"
  | "turn.rollback"
  | "turn.compacted"
  | "model.prompt"
  | "model.completion"
  | "tool.invoked"
  | "tool.completed"
  | "tool.failed"
  | "approval.requested"
  | "approval.resolved"
  | "snapshot.created"
  | "snapshot.reverted"
  | "check.started"
  | "check.completed"
  | string;

export interface SessionEvent<T = any> {
  seq: number;
  ts: string;
  sessionId: string;
  attempt?: number;
  node?: EventGraphNode;
  kind: EventKind;
  data: T;
  prev: string;
}

export interface AppendEventInput<T = any> {
  seq?: number;
  ts?: string;
  sessionId?: string;
  attempt?: number;
  node?: EventGraphNode;
  kind: EventKind;
  data?: T;
  prev?: string;
}

export interface EventLogHeader {
  sessionId: string;
  firstSeq: number;
  lastSeq: number;
  totalEvents: number;
  headHash: string;
}

export interface EventChainVerificationResult {
  valid: boolean;
  totalEvents: number;
  headHash?: string;
}

export class EventChainIntegrityError extends Error {
  public readonly seq?: number;
  public readonly parentSeq?: number;
  public readonly expectedHash?: string;
  public readonly actualHash?: string;

  constructor(
    message: string,
    details?: { seq?: number; parentSeq?: number; expectedHash?: string; actualHash?: string }
  ) {
    super(message);
    this.name = "EventChainIntegrityError";
    this.seq = details?.seq;
    this.parentSeq = details?.parentSeq;
    this.expectedHash = details?.expectedHash;
    this.actualHash = details?.actualHash;
  }
}
