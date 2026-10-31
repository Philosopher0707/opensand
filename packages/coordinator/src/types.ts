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
  provider?: "openai" | "anthropic";
  thinkingBudgetTokens?: number;
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

export interface ApprovalRequest {
  approvalId: string;
  toolName: string;
  arguments: Record<string, any>;
  reason: string;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

export type TurnEventListener = (event: TurnEvent) => void;

export type TurnEvent =
  | { type: "user_message"; content: string }
  | { type: "text_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | { type: "tool_call_started"; toolCall: ToolCall }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "tool_call_completed"; toolCall: ToolCall; result: ToolExecutionResult }
  | { type: "turn_completed"; finalContent: string }
  | { type: "error"; error: Error };
