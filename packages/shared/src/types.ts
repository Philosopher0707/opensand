/**
 * @opensand/shared — canonical types & contracts shared by
 * coordinator, local-exec-daemon, desktop, cli, and native-bridge.
 *
 * Single authority per decision (engineering rule #3): every package
 * imports these definitions instead of re-declaring them.
 */

/* ── Tool definitions & execution ──────────────────────────────── */

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, {
        type: string;
        description?: string;
        default?: any;
        items?: any;
        enum?: string[];
      }>;
      required?: string[];
    };
  };
}

export interface ToolExecutionResult<T = any> {
  status: "ok" | "error" | "permission_pending";
  output?: T;
  error?: {
    code: string;
    message: string;
  };
  approvalId?: string;
}

/* ── Chat / LLM messages ───────────────────────────────────────── */

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

/* ── Agents ──────────────────────────────────────────────────── */

export interface AgentRecord {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  kind?: "AGENT" | "ROOM";
  model?: string;
  endpoint?: string;
  allowedTools?: string[];
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface CreateAgentInput {
  name: string;
  role: string;
  systemPrompt: string;
  kind?: "AGENT" | "ROOM";
  model?: string;
  endpoint?: string;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
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

/* ── Attachments ─────────────────────────────────────────────── */

export interface AttachmentRecord {
  id: string;
  filename: string;
  localPath: string;
  sizeBytes: number;
  mimeType: string;
  sha256: string;
  stagedAtMs: number;
}

/* ── Approvals / turn events ─────────────────────────────────── */

export interface ApprovalRequest {
  approvalId: string;
  toolName: string;
  arguments: Record<string, any>;
  reason: string;
}

export type ApprovalDecision = "allow_once" | "allow_session" | "deny";

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

export type ApprovalDecisionHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

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

export type TurnEventListener = (event: TurnEvent) => void;

/* ── LLM client config ───────────────────────────────────────── */

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

/* ── Desktop / UI ────────────────────────────────────────────── */

export interface DesktopSettings {
  endpoint: string;
  model: string;
  apiKey?: string;
  autoApprove: boolean;
  provider: 'openai' | 'anthropic' | 'openrouter';
  theme: 'dark' | 'light' | 'system';
  maxContextTokens?: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  agentId?: string;
  roomId?: string;
}

export type DesktopEventType =
  | 'session_started'
  | 'token'
  | 'thought'
  | 'tool_call'
  | 'tool_result'
  | 'approval_required'
  | 'turn_complete'
  | 'turn_cancelled'
  | 'error'
  | 'status'
  | 'sentinel';

export interface DesktopEvent {
  type: DesktopEventType;
  sessionId: string;
  data: unknown;
}
