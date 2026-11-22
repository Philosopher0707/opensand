// Shell data layer: wraps window.opensand and HTTP endpoints so components stay testable without a real bridge.
import type { SessionSummary, SessionRow } from "../../src/shell/session-list-model";
import type { MissionSummary } from "../../src/shell/mission-list-model";
import type { RawTimelineEvent } from "../../src/shell/mission-timeline-model";
import type { ReceiptView } from "../../src/shell/mission-receipt-model";
import type { FileDiffView } from "../../src/shell/mission-diff-model";
import type { PreviewRestoreResult, RestoreResult } from "../../src/shell/mission-restore-model";
import type { TimelineForkResult } from "../../src/shell/mission-fork-model";
import type { ToolApprovalRequest } from "../../src/shell/inbox-model";
import type { TurnEvent } from "../../src/shell/quick-capture-model";
import type { Room, DiscussionResult, CreateRoomInput } from "../../src/shell/rooms-model";
import type { Routine, CreateRoutineInput } from "../../src/shell/routines-model";
import type { Skill, CreateSkillInput } from "../../src/shell/skills-model";
import type { VaultSecret, VaultCredential, SecretInput, CredentialInput } from "../../src/shell/vault-model";
import { persistToken } from "../../src/shell/auth-model";
import type { RoomsData } from "./data/rooms";
import type { RoutinesData } from "./data/routines";
import type { SkillsData } from "./data/skills";
import type { VaultData } from "./data/vault";
import { roomsData } from "./data/rooms";
import { routinesData } from "./data/routines";
import { skillsData } from "./data/skills";
import { vaultData } from "./data/vault";

export type { RoomsData, RoutinesData, SkillsData, VaultData };
export { roomsData, routinesData, skillsData, vaultData };


export type { SessionSummary, SessionRow, MissionSummary, ToolApprovalRequest, PreviewRestoreResult, TimelineForkResult, TurnEvent, Room, DiscussionResult, CreateRoomInput, Routine, CreateRoutineInput, Skill, CreateSkillInput, VaultSecret, VaultCredential, SecretInput, CredentialInput };

/** sessionStorage can be blocked in a restricted page; keep the token in memory then. */
function authStorage() {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export interface LoadedSessionData {
  events?: unknown[];
  transcript?: string;
  agentId?: string;
  roomId?: string;
  [key: string]: unknown;
}

export interface TokenTelemetryData {
  estimatedTokens?: number;
  maxContextTokens?: number;
  pct?: number;
  [key: string]: unknown;
}

export interface AgentPersonaData {
  id: string;
  name: string;
  role?: string;
  model?: string;
  systemPrompt?: string;
  kind?: string;
  avatar?: string;
  [key: string]: unknown;
}

export interface CognitiveMemoryData {
  id?: string;
  content?: string;
  fact?: string;
  rule?: string;
  [key: string]: unknown;
}

export interface GrantedSkillData {
  id: string;
  name?: string;
  description?: string;
  [key: string]: unknown;
}

export interface CoreShellData {
  listSessions(): Promise<SessionSummary[]>;
  deleteSession(id: string): Promise<void>;
  listMissions(): Promise<MissionSummary[]>;
  getMissionTimeline(missionId: string): Promise<RawTimelineEvent[]>;
  getMissionReceipt(missionId: string): Promise<ReceiptView | null>;
  getMissionFileDiff(missionId: string, fileIndex: number): Promise<FileDiffView | null>;
  /** Rejects (never resolves empty) when the desktop has no restore channel, so the UI shows an error. */
  previewRestoreMissionSnapshot(missionId: string, snapshot: string): Promise<PreviewRestoreResult>;
  restoreMissionSnapshot(missionId: string, snapshot: string): Promise<RestoreResult>;
  forkMission(missionId: string, snapshot: string | number, options?: { newTitle?: string; newInstruction?: string }): Promise<TimelineForkResult>;
  listPendingApprovals(): Promise<ToolApprovalRequest[]>;
  onApprovalChange?(callback: () => void): () => void;
  /** Answers one approval; the epoch the request was made at must travel with it. Optional: read-only without it. */
  approveTool?(approvalId: string, decision: { action: "approve_once" | "always_allow" | "reject"; epoch: number }): Promise<unknown>;
  /** Starts a chat turn, as the composer does. Optional: a build without a send channel leaves it out. */
  sendQuery?(query: string): Promise<{ success: boolean; sessionId: string }>;
  cancelTurn?(): Promise<unknown>;
  /** Subscribes to every turn event; the caller filters by type and session. Returns the unsubscribe. */
  onTurnEvent?(callback: (event: TurnEvent) => void): () => void;
  /** Loads historical session data (events, transcript, agentId). */
  loadSession?(sessionId: string): Promise<LoadedSessionData | any>;

  // Phase 5 Row 6: Detail Inspector Queries & Controls
  getTokenTelemetry?(agentId?: string, sessionId?: string): Promise<TokenTelemetryData | null>;
  getAgents?(): Promise<AgentPersonaData[]>;
  listMemories?(filter?: { agentId?: string; sessionId?: string; query?: string }): Promise<CognitiveMemoryData[]>;
  listSkills?(): Promise<GrantedSkillData[]>;
  exportAgentTemplate?(id: string): Promise<unknown>;
  clearAllSessions?(): Promise<void>;

  // Phase 5 Row 7: Composer Extras
  stageAttachment?(filePath: string): Promise<{ id: string } | null>;
  listAttachments?(): Promise<any[]>;
  deleteAttachment?(id: string): Promise<void>;

  // Phase 5 Row 12: Auth modal and token exchange
  /** Exchange a server token for a session cookie and remember it for later requests. */
  authenticate(token: string): Promise<any>;
  /** Fires when the server reports an unauthenticated session (401 / auth_required event). */
  onAuthRequired(callback: () => void): () => void;

}

export type ShellData = CoreShellData & RoomsData & RoutinesData & SkillsData & VaultData;

export function windowBridgeData(bridge?: any, http?: typeof fetch): ShellData {
  const b = bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  return {
    async listSessions(): Promise<SessionSummary[]> {
      if (typeof window !== "undefined" && (window as any).__testSessions !== undefined) {
        return (window as any).__testSessions;
      }
      const bridge = (window as any).opensand;
      if (!bridge?.getSessions) {
        return [];
      }
      const res = await bridge.getSessions();
      return Array.isArray(res) ? res : [];
    },
    async listMissions(): Promise<MissionSummary[]> {
      const bridge = (window as any).opensand;
      if (!bridge?.listMissions) {
        return [];
      }
      const res = await bridge.listMissions();
      return Array.isArray(res) ? res : [];
    },
    async getMissionTimeline(missionId: string): Promise<RawTimelineEvent[]> {
      const bridge = (window as any).opensand;
      if (!bridge?.getMissionTimeline) {
        return [];
      }
      const res = await bridge.getMissionTimeline(missionId);
      return Array.isArray(res) ? res : [];
    },
    async getMissionReceipt(missionId: string): Promise<ReceiptView | null> {
      const bridge = (window as any).opensand;
      if (!bridge?.getMissionReceipt) {
        return null;
      }
      return (await bridge.getMissionReceipt(missionId)) ?? null;
    },
    async getMissionFileDiff(missionId: string, fileIndex: number): Promise<FileDiffView | null> {
      const bridge = (window as any).opensand;
      if (!bridge?.getMissionFileDiff) {
        return null;
      }
      return (await bridge.getMissionFileDiff(missionId, fileIndex)) ?? null;
    },
    async previewRestoreMissionSnapshot(missionId: string, snapshot: string): Promise<PreviewRestoreResult> {
      const bridge = (window as any).opensand;
      if (!bridge?.previewRestoreMissionSnapshot) {
        throw new Error("Preview restore is not available in this build");
      }
      return (await bridge.previewRestoreMissionSnapshot(missionId, snapshot)) as PreviewRestoreResult;
    },
    async forkMission(missionId: string, snapshot: string | number, options?: { newTitle?: string; newInstruction?: string }): Promise<TimelineForkResult> {
      const bridge = (window as any).opensand;
      if (!bridge?.forkMission) {
        throw new Error("Fork is not available in this build");
      }
      return (await bridge.forkMission(missionId, snapshot, options)) as TimelineForkResult;
    },
    async restoreMissionSnapshot(missionId: string, snapshot: string): Promise<RestoreResult> {
      const bridge = (window as any).opensand;
      if (!bridge?.restoreMissionSnapshot) {
        throw new Error("Restore is not available in this build");
      }
      return (await bridge.restoreMissionSnapshot(missionId, snapshot)) as RestoreResult;
    },
    approveTool(approvalId, decision) {
      const bridge = (window as any).opensand;
      if (!bridge?.approveTool) return Promise.reject(new Error("Approvals are not available in this build"));
      return bridge.approveTool(approvalId, decision).then((res: any) => {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("opensand:approvals_changed"));
        }
        return res;
      });
    },
    async listPendingApprovals(): Promise<ToolApprovalRequest[]> {
      if (typeof window !== "undefined" && (window as any).__testPendingApprovals) {
        return (window as any).__testPendingApprovals;
      }
      const bridge = (window as any).opensand;
      if (bridge?.listPendingApprovals) {
        const res = await bridge.listPendingApprovals();
        return Array.isArray(res) ? res : [];
      }
      try {
        const res = await fetch("/api/approvals");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when fetch route is not available
      }
      return [];
    },
    onApprovalChange(callback: () => void): () => void {
      const bridge = (window as any).opensand;
      const unsubs: Array<() => void> = [];
      if (bridge?.onEvent) {
        const unsub = bridge.onEvent((event: any) => {
          if (
            event?.type === "approval_required" ||
            event?.type === "approval_resolved" ||
            event?.kind === "approval"
          ) {
            callback();
          }
        });
        unsubs.push(unsub);
      }
      if (typeof window !== "undefined") {
        const handler = () => callback();
        window.addEventListener("opensand:approvals_changed", handler);
        unsubs.push(() => window.removeEventListener("opensand:approvals_changed", handler));
      }
      return () => unsubs.forEach((u) => u());
    },
    async deleteSession(id: string): Promise<void> {
      const bridge = (window as any).opensand;
      if (bridge?.deleteSession) {
        await bridge.deleteSession(id);
      }
    },
    async sendQuery(query: string): Promise<{ success: boolean; sessionId: string }> {
      const bridge = (window as any).opensand;
      if (!bridge?.sendQuery) {
        throw new Error("Sending is not available in this build");
      }
      return (await bridge.sendQuery(query)) as { success: boolean; sessionId: string };
    },
    async cancelTurn(): Promise<unknown> {
      const bridge = (window as any).opensand;
      if (!bridge?.cancelTurn) {
        return undefined;
      }
      return bridge.cancelTurn();
    },
    onTurnEvent(callback: (event: TurnEvent) => void): () => void {
      const bridge = (window as any).opensand;
      if (!bridge?.onEvent) {
        return () => {};
      }
      return bridge.onEvent(callback);
    },
    async loadSession(sessionId: string): Promise<LoadedSessionData | any> {
      if (typeof window !== "undefined" && (window as any).__testLoadedSession) {
        return (window as any).__testLoadedSession;
      }
      const bridge = (window as any).opensand;
      if (!bridge?.loadSession) {
        return null;
      }
      return bridge.loadSession(sessionId);
    },

    async getTokenTelemetry(agentId?: string, sessionId?: string): Promise<TokenTelemetryData | null> {
      if (typeof window !== "undefined" && (window as any).__testTokenTelemetry !== undefined) {
        return (window as any).__testTokenTelemetry;
      }
      const bridge = (window as any).opensand;
      if (bridge?.getTokenTelemetry) {
        try {
          const res = await bridge.getTokenTelemetry(agentId, sessionId);
          if (res) return res;
        } catch {
          // ignore and fall through
        }
      }
      try {
        const params = new URLSearchParams();
        if (agentId) params.set("agentId", agentId);
        if (sessionId) params.set("sessionId", sessionId);
        const qs = params.toString() ? `?${params.toString()}` : "";
        const res = await fetch(`/api/tokens${qs}`);
        if (res.ok) {
          return await res.json();
        }
      } catch {
        // Fallback when fetch route is not available
      }
      return null;
    },

    async getAgents(): Promise<AgentPersonaData[]> {
      if (typeof window !== "undefined" && (window as any).__testAgents !== undefined) {
        return (window as any).__testAgents;
      }
      const bridge = (window as any).opensand;
      if (bridge?.getAgents) {
        try {
          const res = await bridge.getAgents();
          if (Array.isArray(res)) return res;
        } catch {
          // ignore and fall through
        }
      }
      try {
        const res = await fetch("/api/agents");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when fetch route is not available
      }
      return [];
    },

    async listMemories(filter?: { agentId?: string; sessionId?: string; query?: string }): Promise<CognitiveMemoryData[]> {
      if (typeof window !== "undefined" && (window as any).__testMemories !== undefined) {
        return (window as any).__testMemories;
      }
      const bridge = (window as any).opensand;
      if (bridge?.listMemories) {
        try {
          const res = await bridge.listMemories(filter);
          if (Array.isArray(res)) return res;
        } catch {
          // ignore and fall through
        }
      }
      try {
        const res = await fetch("/api/memories");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when fetch route is not available
      }
      return [];
    },

    async listSkills(): Promise<GrantedSkillData[]> {
      if (typeof window !== "undefined" && (window as any).__testSkills !== undefined) {
        return (window as any).__testSkills;
      }
      const bridge = (window as any).opensand;
      if (bridge?.listSkills) {
        try {
          const res = await bridge.listSkills();
          if (Array.isArray(res)) return res;
        } catch {
          // ignore and fall through
        }
      }
      try {
        const res = await fetch("/api/skills");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when fetch route is not available
      }
      return [];
    },

    async exportAgentTemplate(agentId: string): Promise<unknown> {
      const bridge = (window as any).opensand;
      if (bridge?.exportAgentTemplate) {
        try {
          return await bridge.exportAgentTemplate(agentId);
        } catch {
          // ignore and fall through
        }
      }
      try {
        const res = await fetch(`/api/templates/${encodeURIComponent(agentId)}`);
        if (res.ok) {
          return await res.json();
        }
      } catch {
        // Fallback when fetch route is not available
      }
      return null;
    },

    async clearAllSessions(): Promise<void> {
      const bridge = (window as any).opensand;
      if (bridge?.clearAllSessions) {
        await bridge.clearAllSessions();
      }
    },

    async stageAttachment(filePath: string): Promise<{ id: string } | null> {
      const bridge = (window as any).opensand;
      if (bridge?.stageAttachment) {
        return await bridge.stageAttachment(filePath);
      }
      return null;
    },

    async listAttachments(): Promise<any[]> {
      const bridge = (window as any).opensand;
      if (bridge?.listAttachments) {
        return await bridge.listAttachments();
      }
      return [];
    },

    async deleteAttachment(id: string): Promise<void> {
      const bridge = (window as any).opensand;
      if (bridge?.deleteAttachment) {
        await bridge.deleteAttachment(id);
      }
    },

    async authenticate(token: string): Promise<any> {
      const bridge = (window as any).opensand;
      let result: any;
      if (bridge?.authenticate) {
        result = await bridge.authenticate(token);
      } else {
        const res = await fetch("/api/auth/token-exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(payload?.error || `Authentication failed (HTTP ${res.status})`);
        }
        result = payload;
      }
      persistToken(authStorage(), token);
      return result;
    },

    onAuthRequired(callback: () => void): () => void {
      const bridge = (window as any).opensand;
      const unsubs: Array<() => void> = [];
      if (bridge?.onEvent) {
        const unsub = bridge.onEvent((event: any) => {
          if (event?.type === "auth_required" || event?.type === "unauthorized" || event?.kind === "auth") {
            callback();
          }
        });
        unsubs.push(unsub);
      }
      if (typeof window !== "undefined") {
        const handler = () => callback();
        window.addEventListener("opensand:auth_required", handler);
        unsubs.push(() => window.removeEventListener("opensand:auth_required", handler));
      }
      return () => unsubs.forEach((u) => u());
    },

    ...roomsData(b, http),
    ...routinesData(b, http),
    ...skillsData(b, http),
    ...vaultData(b, http),
  };
}
