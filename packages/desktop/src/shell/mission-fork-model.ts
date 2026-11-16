export interface TimelineForkResult {
  success: boolean;
  newMissionId: string;
  forkedFrom: { missionId: string; snapshot: string; targetTree: string };
  restoredFilesCount: number;
  deletedFilesCount: number;
  preRestoreSnapshot: string;
}

import { isRestorableRef } from "./mission-restore-model.js";

export type ForkErrorKind =
  | "untrusted"
  | "running"
  | "invalid_params"
  | "internal_error"
  | "failed";

export interface ClassifiedForkError {
  kind: ForkErrorKind;
  message: string;
  recoveryHint?: string;
  manualRecoveryCommand?: string;
}

export interface ForkConfirmView {
  title: string;
  body: string;
  warning: string;
  confirmLabel: string;
  cancelLabel: string;
}

export function forkConfirmView(step: { kindLabel: string; summary: string }): ForkConfirmView {
  return {
    title: "Fork from this step?",
    body: `${step.kindLabel}: ${step.summary}`,
    warning:
      "A new mission will be created starting from this step\x27s workspace tree. " +
      "Files changed since this step are overwritten, and files created after it are deleted. " +
      "Your own untracked and ignored files are left alone. A safety snapshot is saved first.",
    confirmLabel: "Confirm fork",
    cancelLabel: "Cancel",
  };
}

export function classifyForkError(err: unknown): ClassifiedForkError {
  const code = err && typeof err === "object" && "code" in err ? (err as any).code : undefined;
  const rawMsg =
    err instanceof Error
      ? err.message
      : err && typeof err === "object" && "message" in err
      ? String((err as any).message)
      : typeof err === "string"
      ? err
      : "";
  const errData = err && typeof err === "object" && "data" in err ? (err as any).data : undefined;
  const recoveryCmd =
    errData?.manualRecoveryCommand ||
    (typeof rawMsg === "string" && rawMsg.includes("REC_IDX=")
      ? rawMsg.slice(rawMsg.indexOf("REC_IDX="))
      : undefined);

  if (/untrusted/i.test(rawMsg)) {
    return {
      kind: "untrusted",
      message: "This folder is not trusted yet. Trust the folder, then try again. No files were changed.",
    };
  }
  if (/actively running/i.test(rawMsg)) {
    return {
      kind: "running",
      message: "A mission is still running in this folder. Stop it or wait for it to finish, then try again. No files were changed.",
    };
  }
  if (
    code === -32602 ||
    /invalid.*param/i.test(rawMsg) ||
    /does not belong/i.test(rawMsg) ||
    /invalid mission id/i.test(rawMsg)
  ) {
    return {
      kind: "invalid_params",
      message: rawMsg || "Invalid parameters for fork. Please check the step and try again.",
    };
  }
  if (
    code === -32603 ||
    /internal error/i.test(rawMsg) ||
    /failed to capture pre-restore/i.test(rawMsg) ||
    /restore failed midway/i.test(rawMsg) ||
    /failed to start mission runner/i.test(rawMsg)
  ) {
    const hint = recoveryCmd
      ? `Manual recovery command: ${recoveryCmd}`
      : errData?.preRestoreSnapshot
      ? `Safety snapshot pinned at ${errData.preRestoreSnapshot}. You can restore it to recover.`
      : "A safety snapshot was taken before the fork attempt.";
    return {
      kind: "internal_error",
      message: rawMsg || "Fork failed during workspace restoration.",
      recoveryHint: hint,
      manualRecoveryCommand: recoveryCmd,
    };
  }
  if (
    code === -32600 ||
    /invalid request/i.test(rawMsg) ||
    /already in progress/i.test(rawMsg) ||
    /no-op fork/i.test(rawMsg)
  ) {
    return {
      kind: "failed",
      message: rawMsg || "Cannot fork: invalid request.",
    };
  }
  return {
    kind: "failed",
    message: rawMsg || "Fork failed. Your workspace was not changed unless the safety copy says otherwise; try again.",
  };
}

export function forkSuccessView(
  result: TimelineForkResult,
  stepSeq?: number | string
): { message: string; newMissionId: string; safetySnapshot?: string } {
  const stepPart = stepSeq !== undefined ? ` from step ${stepSeq}` : "";
  const safetyPart = isRestorableRef(result.preRestoreSnapshot)
    ? `. Safety snapshot saved: ${result.preRestoreSnapshot}`
    : "";
  return {
    message: `Forked${stepPart}. New mission ${result.newMissionId} created${safetyPart}.`,
    newMissionId: result.newMissionId,
    safetySnapshot: isRestorableRef(result.preRestoreSnapshot) ? result.preRestoreSnapshot : undefined,
  };
}
