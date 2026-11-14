import type { SessionSummary } from "../../src/shell/session-list-model";

import type { MissionSummary } from "../../src/shell/mission-list-model";

export type { SessionSummary, MissionSummary };

export interface ShellData {
  listSessions(): Promise<SessionSummary[]>;
  deleteSession(id: string): Promise<void>;
  listMissions(): Promise<MissionSummary[]>;
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
    async listMissions(): Promise<MissionSummary[]> {
      const bridge = (window as any).opensand;
      if (!bridge?.listMissions) {
        return [];
      }
      const res = await bridge.listMissions();
      return Array.isArray(res) ? res : [];
    },
    async deleteSession(id: string): Promise<void> {
      const bridge = (window as any).opensand;
      if (bridge?.deleteSession) {
        await bridge.deleteSession(id);
      }
    },
  };
}
