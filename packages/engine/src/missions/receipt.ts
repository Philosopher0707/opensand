import type { SessionEvent } from "@opensand/shared";
import { nextMissionStatus } from "@opensand/shared";
import type { MissionStatus } from "@opensand/shared";
import type { ChangesResult, FileChanges } from "./workspace-diff.js";

export interface Receipt {
  status: "VERIFIED" | "FAILED";
  summary: string;
  changed: FileChanges[];
  changedAvailable: boolean;
  changedReason?: string;
  ran: {
    total: number;
    failed: number;
    lastExitCode?: number | null;
    runs: Array<{ exitCode: number | null; passed: boolean; ts: string }>;
  };
  notDone?: string;
  note?: string;
}

export interface MissionProjection {
  missionId: string;
  title: string;
  status: MissionStatus;
  currentNode: string;
  repairRounds: number;
  checks: unknown[];
  lastClaim?: string;
  receipt?: Receipt;
  budgetSpentUsd: number;
  updatedAt: string;
}

/**
 * Reads the changed lines the runner recorded on the terminal mission record.
 */
function changesFromTerminalRecord(events: SessionEvent[]): ChangesResult | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (
      ev.kind === "mission.verified" ||
      ev.kind === "mission.failed" ||
      ev.kind === "mission.stopped"
    ) {
      const changes = ev.data?.changes;
      if (Array.isArray(changes)) return changes as FileChanges[];
      if (changes && changes.available === false) {
        return { available: false, reason: changes.reason };
      }
      return undefined;
    }
  }
  return undefined;
}

/**
 * Projects a verified or failed receipt from an event stream.
 *
 * verified iff the last check.completed after the last node.completed{node:"act"}
 * has passed: true and a review.completed{accept:true} follows it. The agent's
 * claim never enters this decision.
 */
export function projectReceipt(events: SessionEvent[], changes?: ChangesResult): Receipt {
  let lastActIdx = -1;
  let lastClaim: string | undefined;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.kind === "node.completed" && ev.data?.node === "act") {
      lastActIdx = i;
      if (ev.data?.claim) {
        lastClaim = ev.data.claim;
      }
    }
  }

  let lastCheckAfterAct: SessionEvent | null = null;
  let lastCheckAfterActIdx = -1;
  const allChecks: SessionEvent[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.kind === "check.completed") {
      allChecks.push(ev);
      if (i > lastActIdx) {
        lastCheckAfterAct = ev;
        lastCheckAfterActIdx = i;
      }
    }
  }

  let reviewAcceptedAfterCheck = false;
  let reviewNote: string | undefined;

  if (lastCheckAfterAct && lastCheckAfterActIdx >= 0) {
    for (let i = lastCheckAfterActIdx + 1; i < events.length; i++) {
      const ev = events[i];
      if (ev.kind === "review.completed" && ev.data?.accept === true) {
        reviewAcceptedAfterCheck = true;
        reviewNote = ev.data?.note;
        break;
      }
    }
  }

  const checkPassedAfterAct = lastCheckAfterAct?.data?.passed === true;
  const isVerified = Boolean(
    lastActIdx >= 0 &&
    checkPassedAfterAct &&
    reviewAcceptedAfterCheck
  );

  const source = changes ?? changesFromTerminalRecord(events);
  let changed: FileChanges[] = [];
  let changedAvailable = true;
  let changedReason: string | undefined;

  if (source) {
    if (Array.isArray(source)) {
      changed = source;
    } else {
      changedAvailable = false;
      changedReason = source.reason;
    }
  }

  const runs = allChecks.map((c) => ({
    exitCode: c.data?.exitCode ?? null,
    passed: c.data?.passed === true,
    ts: c.ts,
  }));
  const totalRuns = runs.length;
  const failedRuns = runs.filter((r) => !r.passed).length;
  const lastRun = runs[runs.length - 1];

  let summary = "";
  if (isVerified) {
    summary = `check exited 0 (${totalRuns} run${totalRuns === 1 ? "" : "s"}`;
    if (failedRuns > 0) {
      summary += `: ${failedRuns} failed, passed at ${lastRun?.ts ?? "completion"}`;
    }
    summary += `)`;
  } else {
    const code = lastRun?.exitCode ?? 1;
    summary = `check exited ${code} (${totalRuns} run${totalRuns === 1 ? "" : "s"})`;
  }

  return {
    status: isVerified ? "VERIFIED" : "FAILED",
    summary,
    changed,
    changedAvailable,
    changedReason,
    ran: {
      total: totalRuns,
      failed: failedRuns,
      lastExitCode: lastRun?.exitCode,
      runs,
    },
    notDone: lastClaim,
    note: reviewNote,
  };
}

export function renderReceipt(receipt: Receipt): string {
  const lines: string[] = [];

  if (receipt.status === "VERIFIED") {
    lines.push(`VERIFIED  ${receipt.summary}`);
  } else {
    lines.push(`FAILED    ${receipt.summary}`);
  }

  if (!receipt.changedAvailable) {
    lines.push(`Changed   (${receipt.changedReason ?? "not available"})`);
  } else if (receipt.changed.length === 0) {
    lines.push(`Changed   (none)`);
  } else {
    for (let i = 0; i < receipt.changed.length; i++) {
      const c = receipt.changed[i];
      const prefix = i === 0 ? "Changed   " : "          ";
      const rangesStr = c.ranges
        .map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`))
        .join(", ");
      const suffix = rangesStr || (c.deletedAt ? "(deleted)" : "(renamed)");
      lines.push(`${prefix}${c.file.padEnd(35)} ${suffix}`);
    }
  }

  lines.push(
    `Ran       ${receipt.ran.total} command${receipt.ran.total === 1 ? "" : "s"}, ${receipt.ran.failed} non-zero`
  );

  if (receipt.notDone) {
    lines.push(`Not done  ${receipt.notDone} (model note; unverified)`);
  }

  return lines.join("\n");
}

export function projectMission(events: SessionEvent[]): MissionProjection {
  let missionId = "";
  let title = "";
  let status: MissionStatus = "running";
  let currentNode = "plan";
  let repairRounds = 0;
  const checks: unknown[] = [];
  let lastClaim: string | undefined;
  let updatedAt = "";

  for (const ev of events) {
    updatedAt = ev.ts;
    if (ev.sessionId) missionId = ev.sessionId;

    status = nextMissionStatus(status, ev.kind);
    if (ev.kind === "mission.started") {
      title = ev.data?.title ?? title;
    } else if (ev.kind === "node.started") {
      currentNode = ev.data?.node ?? currentNode;
      if (ev.data?.node === "repair") {
        repairRounds += 1;
      }
    } else if (ev.kind === "node.completed") {
      if (ev.data?.node === "act" && ev.data?.claim) {
        lastClaim = ev.data.claim;
      }
    } else if (ev.kind === "check.completed") {
      checks.push(ev.data);
    }
  }

  const receipt = projectReceipt(events);

  return {
    missionId,
    title,
    status,
    currentNode,
    repairRounds,
    checks,
    lastClaim,
    receipt,
    budgetSpentUsd: 0,
    updatedAt,
  };
}
