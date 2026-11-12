import type { DenialReason } from "@opensand/shared";

/** A tool refused to run for a known reason; `dispatch` maps it to a typed error result. */
export class ToolDenialError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly reason: DenialReason
  ) {
    super(message);
    this.name = "ToolDenialError";
  }
}

export class WorkspaceEscapeError extends ToolDenialError {
  constructor(message: string) {
    super(message, "PATH_OUTSIDE_WORKSPACE", "workspace_escape");
    this.name = "WorkspaceEscapeError";
  }
}

export class SafetyGateError extends ToolDenialError {
  constructor(message: string) {
    super(message, "SAFETY_GATE_BLOCKED", "safety_gate");
    this.name = "SafetyGateError";
  }
}
