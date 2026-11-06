import { ToolDefinition, ToolExecutionResult } from "@opensand/local-exec-daemon";

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface StreamDelta {
  content?: string;
  thinking?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
  finish_reason?: string | null;
}

export interface LLMClientConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  provider?: "openai" | "anthropic" | "openrouter";
  thinkingBudgetTokens?: number;
  enablePromptCaching?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

export interface ApprovalRequest {
  approvalId: string;
  toolName: string;
  arguments: Record<string, any>;
  reason: string;
}

export type ApprovalDecision = "allow_once" | "allow_session" | "deny";

export interface AttachmentRecord {
  id: string;
  filename: string;
  localPath: string;
  sizeBytes: number;
  mimeType: string;
  sha256: string;
  stagedAtMs: number;
}

export interface AgentTemplate {
  templateVersion: string;
  name: string;
  role: string;
  description?: string;
  systemPrompt: string;
  kind?: "AGENT" | "ROOM";
  model?: string;
  endpoint?: string;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
  exportedAtMs: number;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

/** Handler that can return a richer decision (allow once / allow session / deny). */
export type ApprovalDecisionHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export type TurnEventListener = (event: TurnEvent) => void;

/** Phase of a turn iteration: the LLM is thinking or tools are executing. */
export type TurnPhase = "thinking" | "executing";

export type TurnEvent =
  | { type: "user_message"; content: string }
  | { type: "phase_started"; phase: TurnPhase; iteration: number; maxIterations: number }
  | { type: "text_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | { type: "tool_call_started"; toolCall: ToolCall }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "tool_call_completed"; toolCall: ToolCall; result: ToolExecutionResult }
  | { type: "turn_completed"; finalContent: string }
  | { type: "error"; error: Error };
