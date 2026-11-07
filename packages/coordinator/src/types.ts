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
