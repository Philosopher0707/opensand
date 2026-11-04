export interface DesktopSettings {
  endpoint: string;
  model: string;
  apiKey?: string;
  autoApprove: boolean;
  provider: 'openai' | 'anthropic';
  theme: 'dark' | 'light' | 'system';
  maxContextTokens?: number;
}

export interface ToolApprovalRequest {
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
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
  | 'token'
  | 'thought'
  | 'tool_call'
  | 'tool_result'
  | 'approval_required'
  | 'turn_complete'
  | 'error'
  | 'status'
  | 'sentinel';

export interface DesktopEvent {
  type: DesktopEventType;
  sessionId: string;
  data: unknown;
}

export interface OpenSandBridgeApi {
  sendQuery: (query: string, sessionId?: string) => Promise<{ success: boolean; sessionId: string }>;
  approveTool: (approvalId: string, decision: ApprovalDecision) => Promise<{ success: boolean }>;
  getSessions: () => Promise<SessionSummary[]>;
  loadSession: (sessionId: string) => Promise<{ events: unknown[]; transcript: string }>;
  deleteSession?: (sessionId: string) => Promise<{ success: boolean }>;
  clearAllSessions?: () => Promise<{ success: boolean; count: number }>;
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
