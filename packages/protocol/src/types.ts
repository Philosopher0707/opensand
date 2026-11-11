export type ApprovalDecision = "allow_once" | "allow_mission" | "allow_folder" | "deny";

export interface ApprovalItem {
  approvalId: string;
  missionId: string;
  epoch: number;
  createdAt: string;
  tool: string;
  scope: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  initiator: "human" | "routine" | "webhook" | "subagent";
  reason: string;
}

export interface TimelineNode {
  nodeId: string;
  name: "plan" | "act" | "check" | "repair" | "review" | "receipt";
  status: "pending" | "running" | "completed" | "failed";
  seqStart: number;
  seqEnd?: number;
  durationMs?: number;
}

export interface Checkpoint {
  checkpointId: string;
  seq: number;
  snapshotId: string;
  label: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  seq?: number;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}
