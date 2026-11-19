import type { SessionSummary } from "../../src/shell/session-list-model";
import type { AgentRecord } from "@opensand/shared";

export type { SessionSummary };
export type { AgentRecord };

export interface ShellData {
  listSessions(): Promise<SessionSummary[]>;
  deleteSession(id: string): Promise<void>;
  listAgents(): Promise<AgentRecord[]>;
  updateAgentSettings(id: string, updates: Record<string, any>): Promise<any>;
  loadSession(sessionId: string): Promise<any>;
  updateAgentProfile(id: string, updates: Record<string, any>): Promise<any>;
  listProfileChanges(agentId: string): Promise<any[]>;
}

export function windowBridgeData(): ShellData {
  return {
    async listSessions(): Promise<SessionSummary[]> {
      const bridge = (window as any).opensand;
      if (!bridge?.getSessions) {
        return [];
      }
      const res = await bridge.getSessions();
      return Array.isArray(res) ? res : [];
    },
    async deleteSession(id: string): Promise<void> {
      const bridge = (window as any).opensand;
      if (bridge?.deleteSession) {
        await bridge.deleteSession(id);
      }
    },
    async listAgents(): Promise<AgentRecord[]> {
      const bridge = (window as any).opensand;
      if (!bridge?.getAgents) {
        return [];
      }
      const res = await bridge.getAgents();
      return Array.isArray(res) ? res : [];
    },
    async updateAgentSettings(id: string, updates: Record<string, any>): Promise<any> {
      const bridge = (window as any).opensand;
      if (bridge?.updateAgentSettings) {
        return bridge.updateAgentSettings(id, updates);
      }
    },
    async loadSession(sessionId: string): Promise<any> {
      const bridge = (window as any).opensand;
      if (bridge?.loadSession) {
        return bridge.loadSession(sessionId);
      }
    },
    async updateAgentProfile(id: string, updates: Record<string, any>): Promise<any> {
      const bridge = (window as any).opensand;
      if (bridge?.updateAgentProfile) {
        return bridge.updateAgentProfile(id, updates);
      }
    },
    async listProfileChanges(agentId: string): Promise<any[]> {
      const bridge = (window as any).opensand;
      if (bridge?.listProfileChanges) {
        return bridge.listProfileChanges(agentId);
      }
      return [];
    },
    async setAgentAvatar(agentId: string, avatarUrl: string | null): Promise<any> {
      const bridge = (window as any).opensand;
      if (bridge?.setAgentAvatar) {
        return bridge.setAgentAvatar(agentId, avatarUrl);
      }
    },
    async updateAgentApproval(id: string, updates: { approvalMode?: string; autoApprove?: boolean; alwaysAllow?: string[] }): Promise<any> {
      const bridge = (window as any).opensand;
      if (bridge?.updateAgentApproval) {
        return bridge.updateAgentApproval(id, updates);
      }
    },
    async updateAgentSection(id: string, updates: { section?: string; chiefOfStaff?: boolean; managedSections?: string[]; createdBy?: string; reportsTo?: string; visibility?: string }): Promise<any> {
      const bridge = (window as any).opensand;
      if (bridge?.updateAgentSection) {
        return bridge.updateAgentSection(id, updates);
      }
    },
    async updateAgentVoice(id: string, updates: { voice?: string; speakReplies?: boolean; voiceNotes?: boolean; replyStyle?: string }): Promise<any> {
      const bridge = (window as any).opensand;
      if (bridge?.updateAgentVoice) {
        return bridge.updateAgentVoice(id, updates);
      }
    },
  };
}
