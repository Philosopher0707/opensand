/**
 * Desktop types — canonical UI contracts live in @opensand/shared.
 * This module is a thin shim: shared contracts are re-exported, while
 * desktop-only approval/bridge shapes stay local.
 */
export type { DesktopSettings, SessionSummary, DesktopEvent, DesktopEventType } from '@opensand/shared';
import type { DesktopSettings, SessionSummary, DesktopEvent } from '@opensand/shared';

export interface ToolApprovalRequest {
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason?: string;
  timestamp: number;
  /** Grants epoch the request was created at; the answer must echo it. */
  epoch: number;
}

export interface ToolDiscoverySummary {
  totalTools: number;
  capabilities: string[];
  tools: Array<{
    name: string;
    description: string;
    parameters: string[];
    capabilities: string[];
  }>;
}

export interface ApprovalDecision {
  action: 'approve_once' | 'always_allow' | 'reject';
  epoch?: number;
  reason?: string;
}

export interface OpenSandBridgeApi {
  sendQuery: (query: string, sessionId?: string, agentId?: string) => Promise<{ success: boolean; sessionId: string }>;
  cancelTurn?: () => Promise<{ success: boolean; cancelled: boolean }>;
  approveTool: (approvalId: string, decision: ApprovalDecision) => Promise<{ success: boolean; newEpoch?: number }>;
  listPendingApprovals?: () => Promise<ToolApprovalRequest[]>;
  getToolDiscovery?: () => Promise<ToolDiscoverySummary>;
  executeTool?: (name: string, args: Record<string, any>, context?: any) => Promise<any>;
  ensureDaemon?: () => Promise<any>;
  getSessions: () => Promise<SessionSummary[]>;
  listMissions?: () => Promise<Array<{ missionId: string; title: string; status: string; updatedAt: string }>>;
  getMissionTimeline?: (missionId: string) => Promise<Array<{ seq: number; ts: string; kind: string; data: Record<string, unknown> }>>;
  getMissionReceipt?: (missionId: string) => Promise<import('./shell/mission-receipt-model.js').ReceiptView | null>;
  loadSession: (sessionId: string) => Promise<{ events: unknown[]; transcript: string; agentId?: string; roomId?: string }>;
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
