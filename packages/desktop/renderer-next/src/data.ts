import type { SessionSummary } from "../../src/shell/session-list-model";
import type { AgentRecord } from "@opensand/shared";

export type { SessionSummary };
export type { AgentRecord };

export interface ShellData {
  listSessions(): Promise<SessionSummary[]>;
  deleteSession(id: string): Promise<void>;
  listAgents(): Promise<AgentRecord[]>;
  updateAgentSettings(id: string, updates: Record<string, any>): Promise<any>;
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
  };
}
