import { isRestorableRef, type TimelineStep, type TimelineStepNode } from "@opensand/protocol";
import type { SessionEvent } from "@opensand/shared";

const VALID_NODES = new Set<string>([
  "start",
  "plan",
  "act",
  "check",
  "review",
  "repair",
  "receipt",
  "end",
]);

export function projectTimelineSteps(events: SessionEvent[]): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const pendingSnapshot = new Map<string, { snapshot: string; seq: number; ts: string }>();
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  for (const ev of sorted) {
    const d = ev.data ?? {};
    switch (ev.kind) {
      case "mission.started":
      case "mission.forked": {
        steps.push({
          seq: ev.seq,
          node: "start",
          title:
            typeof d.title === "string" && d.title.trim()
              ? d.title.trim()
              : ev.kind === "mission.forked"
              ? "Mission forked"
              : "Mission started",
          timestamp: ev.ts,
          isRestorable: false,
        });
        break;
      }
      case "node.started": {
        const snap =
          typeof d.snapshot === "string"
            ? d.snapshot
            : typeof d.snapshotRef === "string"
            ? d.snapshotRef
            : undefined;
        if (snap) {
          pendingSnapshot.set(String(d.node), { snapshot: snap, seq: ev.seq, ts: ev.ts });
        }
        break;
      }
      case "node.completed": {
        const nodeStr = String(d.node);
        const node: TimelineStepNode = VALID_NODES.has(nodeStr)
          ? (nodeStr as TimelineStepNode)
          : "act";

        const pending = pendingSnapshot.get(nodeStr);
        const snapshotRef =
          pending?.snapshot ??
          (typeof d.snapshot === "string"
            ? d.snapshot
            : typeof d.snapshotRef === "string"
            ? d.snapshotRef
            : undefined);
        pendingSnapshot.delete(nodeStr);

        const title =
          typeof d.claim === "string" && d.claim.trim()
            ? d.claim.trim()
            : `${node === "act" ? "Work" : node.charAt(0).toUpperCase() + node.slice(1)} completed`;

        const step: TimelineStep = {
          seq: ev.seq,
          node,
          title,
          timestamp: ev.ts,
          isRestorable: isRestorableRef(snapshotRef),
        };
        if (typeof d.claim === "string") step.claim = d.claim;
        if (typeof d.durationMs === "number") step.durationMs = d.durationMs;
        if (snapshotRef) step.snapshotRef = snapshotRef;
        steps.push(step);
        break;
      }
      case "check.completed": {
        const passed = d.passed === true;
        const code = d.exitCode !== undefined && d.exitCode !== null ? ` (exit ${d.exitCode})` : "";
        const step: TimelineStep = {
          seq: ev.seq,
          node: "check",
          title: (passed ? "Check passed" : "Check failed") + code,
          passed,
          timestamp: ev.ts,
          isRestorable: false,
        };
        if (typeof d.durationMs === "number") step.durationMs = d.durationMs;
        steps.push(step);
        break;
      }
      case "review.completed": {
        const passed = d.accept === true;
        const note = typeof d.note === "string" ? d.note : undefined;
        const step: TimelineStep = {
          seq: ev.seq,
          node: "review",
          title: (passed ? "Accepted" : "Changes requested") + (note ? `: ${note}` : ""),
          passed,
          timestamp: ev.ts,
          isRestorable: false,
        };
        if (note) step.claim = note;
        steps.push(step);
        break;
      }
      case "mission.verified": {
        steps.push({
          seq: ev.seq,
          node: "end",
          title: "Verified",
          passed: true,
          timestamp: ev.ts,
          isRestorable: false,
        });
        break;
      }
      case "mission.failed": {
        const errorMsg = typeof d.error === "string" ? `: ${d.error}` : "";
        steps.push({
          seq: ev.seq,
          node: "end",
          title: `Failed${errorMsg}`,
          passed: false,
          timestamp: ev.ts,
          isRestorable: false,
        });
        break;
      }
      case "mission.stopped": {
        const reasonMsg = typeof d.reason === "string" ? `: ${d.reason}` : "";
        steps.push({
          seq: ev.seq,
          node: "end",
          title: `Stopped${reasonMsg}`,
          timestamp: ev.ts,
          isRestorable: false,
        });
        break;
      }
    }
  }

  // Any remaining uncompleted node that had a snapshot (e.g. stopped while running)
  for (const [nodeStr, pending] of pendingSnapshot.entries()) {
    const node: TimelineStepNode = VALID_NODES.has(nodeStr)
      ? (nodeStr as TimelineStepNode)
      : "act";
    steps.push({
      seq: pending.seq,
      node,
      title: `${node === "act" ? "Work" : node.charAt(0).toUpperCase() + node.slice(1)} started`,
      timestamp: pending.ts,
      snapshotRef: pending.snapshot,
      isRestorable: isRestorableRef(pending.snapshot),
    });
  }

  steps.sort((a, b) => a.seq - b.seq);
  return steps;
}
