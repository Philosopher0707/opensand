// Shell data layer: wraps window.opensand and HTTP endpoints so components stay testable without a real bridge.
import type { SessionSummary, SessionRow } from "../../src/shell/session-list-model";
import { SESSIONS_CHANGED_EVENT, sessionRenameRequest } from "../../src/shell/session-list-model";
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
import type { Watcher, SentinelLog, CreateWatcherInput } from "../../src/shell/sentinel-model";
import type { PolicyRule, PolicyAuditEntry, CreateRuleInput } from "../../src/shell/boundaries-model";
import type { Attachment } from "../../src/shell/attachments-model";
import type { VaultSecret, VaultCredential, SecretInput, CredentialInput } from "../../src/shell/vault-model";
import { persistToken } from "../../src/shell/auth-model";
import type { OnboardingState } from "../../src/onboarding";
import type { DesktopSettings } from "../../src/types";
import { querySendArgs } from "../../src/shell/query-send-model";
import type { RoomsData } from "./data/rooms";
import type { RoutinesData } from "./data/routines";
import type { SkillsData } from "./data/skills";
import type { AttachmentsData } from "./data/attachments";
import type { VaultData } from "./data/vault";
import { roomsData } from "./data/rooms";
import { routinesData } from "./data/routines";
import { skillsData } from "./data/skills";
import { attachmentsData } from "./data/attachments";
import { vaultData } from "./data/vault";
import type { MemoriesData } from "./data/memories";
import { memoriesData } from "./data/memories";
import type { BotsData } from "./data/bots";
import type { SentinelData } from "./data/sentinel";
import { botsData } from "./data/bots";
import { sentinelData } from "./data/sentinel";
export type { Attachment, AttachmentsData, BotsData, BoundariesData, CreateRoomInput, CreateRoutineInput, CreateRuleInput, CreateSkillInput, CreateWatcherInput, CredentialInput, DiscussionResult, MemoriesData, MissionSummary, PolicyAuditEntry, PolicyRule, PreviewRestoreResult, Room, RoomsData, Routine, RoutinesData, SecretInput, SentinelData, SentinelLog, SessionRow, SessionSummary, Skill, SkillsData, TimelineForkResult, ToolApprovalRequest, TurnEvent, VaultCredential, VaultData, VaultSecret, Watcher };
export { attachmentsData, botsData, boundariesData, memoriesData, roomsData, routinesData, sentinelData, skillsData, vaultData };
import type { BoundariesData } from "./data/boundaries";
import { boundariesData } from "./data/boundaries";

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

function notifySessionsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SESSIONS_CHANGED_EVENT));
  }
}

export interface CoreShellData {
  listSessions(): Promise<SessionSummary[]>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<boolean>;
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
  sendQuery?(query: string, sessionId?: string, agentId?: string): Promise<{ success: boolean; sessionId: string }>;
  cancelTurn?(): Promise<unknown>;
  /** Menu/tray Settings: the renderer navigates to the settings view when this fires. */
  onOpenSettings?(callback: () => void): () => void;
  /** Inspector session controls; the server exposes them at POST /api/rollback and /api/compact. */
  rollback?(): Promise<{ removedMessages: number; remainingMessages: number }>;
  compact?(): Promise<{ originalTokens: number; compactedTokens: number; compactedTurnCount: number }>;
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

  // Setup / provider settings (Preact Settings and Welcome views)
  /** Sanitized settings: the API key is a mask, never the stored secret. */
  getSettings?(): Promise<DesktopSettings>;
  /** Read-only app version for the Settings footer; carries no settings or keys. */
  getVersion?(): Promise<{ app?: unknown }>;
  saveSettings?(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  getOnboardingState?(): Promise<OnboardingState>;
  saveOnboarding?(input: { mode: "ollama"; model?: string } | { mode: "key"; endpoint: string; model: string; apiKey: string }): Promise<{ ok: boolean }>;
  testConnection?(input: { endpoint: string; model: string; apiKey: string; provider?: string }): Promise<{ ok: boolean; error?: string }>;

  // Phase 5 Row 12: Auth modal and token exchange
  /** Exchange a server token for a session cookie and remember it for later requests. */
  authenticate(token: string): Promise<any>;
  /** Fires when the server reports an unauthenticated session (401 / auth_required event). */
  onAuthRequired(callback: () => void): () => void;

}

export type ShellData = CoreShellData & RoomsData & RoutinesData & SkillsData & AttachmentsData & VaultData & MemoriesData & BotsData & SentinelData & BoundariesData;

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
      notifySessionsChanged();
    },
    async renameSession(id: string, title: string): Promise<boolean> {
      const { url, init } = sessionRenameRequest(id, title);
      const res = await (http ?? fetch)(url, init);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `Rename failed (HTTP ${res.status})`);
      notifySessionsChanged();
      return payload?.success !== false;
    },
    async sendQuery(query: string, sessionId?: string, agentId?: string): Promise<{ success: boolean; sessionId: string }> {
      const bridge = (window as any).opensand;
      if (!bridge?.sendQuery) {
        throw new Error("Sending is not available in this build");
      }
      const result = (await bridge.sendQuery(...querySendArgs(query, sessionId, agentId))) as { success: boolean; sessionId: string };
      if (result?.success) notifySessionsChanged();
      return result;
    },
    async cancelTurn(): Promise<unknown> {
      const bridge = (window as any).opensand;
      if (!bridge?.cancelTurn) {
        return undefined;
      }
      return bridge.cancelTurn();
    },
    onOpenSettings(callback: () => void): () => void {
      const bridge = (window as any).opensand;
      if (!bridge?.onOpenSettings) return () => {};
      return bridge.onOpenSettings(callback);
    },
    async getSettings(): Promise<DesktopSettings> {
      const res = await (http ?? fetch)("/api/settings");
      if (!res.ok) throw new Error("Settings are unavailable");
      return (await res.json()) as DesktopSettings;
    },
    async getVersion(): Promise<{ app?: unknown }> {
      const res = await (http ?? fetch)("/api/version");
      if (!res.ok) throw new Error("Version unavailable");
      return (await res.json()) as { app?: unknown };
    },
    async saveSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings> {
      const res = await (http ?? fetch)("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `Settings save failed (HTTP ${res.status})`);
      return payload as DesktopSettings;
    },
    async getOnboardingState(): Promise<OnboardingState> {
      const res = await (http ?? fetch)("/api/onboarding");
      if (!res.ok) throw new Error("Setup check is unavailable");
      return (await res.json()) as OnboardingState;
    },
    async saveOnboarding(input): Promise<{ ok: boolean }> {
      const res = await (http ?? fetch)("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `Setup failed (HTTP ${res.status})`);
      return payload as { ok: boolean };
    },
    async testConnection(input): Promise<{ ok: boolean; error?: string }> {
      const res = await (http ?? fetch)("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: payload?.error || "Could not test the connection." };
      return payload as { ok: boolean; error?: string };
    },
    async rollback(): Promise<{ removedMessages: number; remainingMessages: number }> {
      const doFetch = http ?? fetch;
      const res = await doFetch("/api/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turns: 1 }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `Rollback failed (HTTP ${res.status})`);
      return payload;
    },
    async compact(): Promise<{ originalTokens: number; compactedTokens: number; compactedTurnCount: number }> {
      const doFetch = http ?? fetch;
      const res = await doFetch("/api/compact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepRecentTurns: 2 }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `Compact failed (HTTP ${res.status})`);
      return payload;
    },
    onTurnEvent(callback: (event: TurnEvent) => void): () => void {
      const bridge = (window as any).opensand;
      if (!bridge?.onEvent) {
        return () => {};
      }
      return bridge.onEvent((event: TurnEvent) => {
        if (event?.type === "turn_complete") notifySessionsChanged();
        callback(event);
      });
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
    ...attachmentsData(b, http),
    ...vaultData(b, http),
    ...memoriesData(b, http),
    ...botsData(b, http),
    ...sentinelData(b, http),
    ...boundariesData(b, http),
  };
}
