import type { SessionSummary } from "../../src/shell/session-list-model";

export type { SessionSummary };

export interface ShellData {
  listSessions(): Promise<SessionSummary[]>;
  deleteSession(id: string): Promise<void>;
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
  };
}
