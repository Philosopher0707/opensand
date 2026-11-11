/**
 * Coordinator types — canonical definitions live in @opensand/shared.
 * This module is a thin re-export shim for backwards compatibility.
 */
export type {
  ToolCallFunction, ToolCall, ChatMessage, StreamDelta, LLMClientConfig,
  ApprovalRequest, ApprovalDecision, AttachmentRecord, AgentTemplate,
  ApprovalHandler, ApprovalDecisionHandler, TurnEventListener, TurnPhase, TurnEvent, SubagentInfo,
} from "@opensand/shared";
export type { ToolDefinition, ToolExecutionResult } from "@opensand/local-exec-daemon";

export interface SessionRecoveryWarning {
  type: "truncated_tail_discarded" | "corrupt_line_skipped" | "orphaned_tool_calls_reconciled";
  lineNumber?: number;
  rawSnippet?: string;
  remedy: string;
}

export interface SessionRecoveryReport {
  recoveredMessages: number;
  discardedEntries: number;
  warnings: SessionRecoveryWarning[];
}

export interface SessionMetadata {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  endpoint: string;
  provider?: string;
  title?: string;
  agentId?: string;
  roomId?: string;
  turnCount?: number;
}

export interface SessionLockInfo {
  pid: number;
  startedAt: number;
  hostname: string;
}
