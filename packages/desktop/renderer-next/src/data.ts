import type { SessionSummary } from "../../src/shell/session-list-model";

import type { MissionSummary } from "../../src/shell/mission-list-model";
import type { RawTimelineEvent } from "../../src/shell/mission-timeline-model";
import type { FileDiffView } from "../../src/shell/mission-diff-model";
import type { ReceiptView } from "../../src/shell/mission-receipt-model";

export type { SessionSummary, MissionSummary };

export interface ShellData {
  listSessions(): Promise<SessionSummary[]>;
  deleteSession(id: string): Promise<void>;
  listMissions(): Promise<MissionSummary[]>;
  getMissionTimeline(missionId: string): Promise<RawTimelineEvent[]>;
  getMissionReceipt(missionId: string): Promise<ReceiptView | null>;
  getMissionFileDiff(missionId: string, fileIndex: number): Promise<FileDiffView | null>;
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
    async deleteSession(id: string): Promise<void> {
      const bridge = (window as any).opensand;
      if (bridge?.deleteSession) {
        await bridge.deleteSession(id);
      }
    },
  };
}
