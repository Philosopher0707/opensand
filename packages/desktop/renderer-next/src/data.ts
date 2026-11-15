import type { SessionSummary } from "../../src/shell/session-list-model";
import type { MissionSummary } from "../../src/shell/mission-list-model";
import type { RawTimelineEvent } from "../../src/shell/mission-timeline-model";
import type { FileDiffView } from "../../src/shell/mission-diff-model";
import type { ReceiptView } from "../../src/shell/mission-receipt-model";
import type { ToolApprovalRequest } from "../../src/shell/inbox-model";

export type { SessionSummary, MissionSummary, ToolApprovalRequest };

export interface ShellData {
  listSessions(): Promise<SessionSummary[]>;
  deleteSession(id: string): Promise<void>;
  listMissions(): Promise<MissionSummary[]>;
  getMissionTimeline(missionId: string): Promise<RawTimelineEvent[]>;
  getMissionReceipt(missionId: string): Promise<ReceiptView | null>;
  getMissionFileDiff(missionId: string, fileIndex: number): Promise<FileDiffView | null>;
  listPendingApprovals(): Promise<ToolApprovalRequest[]>;
  onApprovalChange?(callback: () => void): () => void;
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
  };
}
