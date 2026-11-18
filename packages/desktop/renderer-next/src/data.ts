import type { SessionSummary } from "../../src/shell/session-list-model";
import type { MissionSummary } from "../../src/shell/mission-list-model";
import type { RawTimelineEvent } from "../../src/shell/mission-timeline-model";
import type { FileDiffView } from "../../src/shell/mission-diff-model";
import type { ReceiptView } from "../../src/shell/mission-receipt-model";
import type { RestoreResult, PreviewRestoreResult } from "../../src/shell/mission-restore-model";
import type { TimelineForkResult } from "../../src/shell/mission-fork-model";
import type { ToolApprovalRequest } from "../../src/shell/inbox-model";
import type { TurnEvent } from "../../src/shell/quick-capture-model";

export type { SessionSummary, MissionSummary, ToolApprovalRequest, PreviewRestoreResult, TimelineForkResult, TurnEvent };

export interface ShellData {
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
      return bridge.approveTool(approvalId, decision);
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
  };
}
