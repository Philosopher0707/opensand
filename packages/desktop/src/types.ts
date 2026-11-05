export interface DesktopSettings {
  endpoint: string;
  model: string;
  apiKey?: string;
  autoApprove: boolean;
  provider: 'openai' | 'anthropic' | 'openrouter';
  theme: 'dark' | 'light' | 'system';
  maxContextTokens?: number;
}

export interface ToolApprovalRequest {
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason?: string;
  timestamp: number;
}

export interface ApprovalDecision {
  action: 'approve_once' | 'always_allow' | 'reject';
  reason?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
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

export interface OpenSandBridgeApi {
  sendQuery: (query: string, sessionId?: string, agentId?: string) => Promise<{ success: boolean; sessionId: string }>;
  cancelTurn?: () => Promise<{ success: boolean; cancelled: boolean }>;
  approveTool: (approvalId: string, decision: ApprovalDecision) => Promise<{ success: boolean }>;
  getSessions: () => Promise<SessionSummary[]>;
  loadSession: (sessionId: string) => Promise<{ events: unknown[]; transcript: string }>;
  deleteSession?: (sessionId: string) => Promise<{ success: boolean }>;
  clearAllSessions?: () => Promise<{ success: boolean; count: number }>;
  deleteAgent?: (id: string) => Promise<boolean>;
  getSettings: () => Promise<DesktopSettings>;
  updateSettings: (settings: Partial<DesktopSettings>) => Promise<DesktopSettings>;
  onEvent: (callback: (event: DesktopEvent) => void) => () => void;
  getTokenTelemetry?: (agentId?: string, sessionId?: string) => Promise<{
    estimatedTokens: number;
    maxContextTokens: number;
    toolScopeMode: string;
    turnsCount: number;
    messagesCount: number;
    model: string;
  }>;
}
