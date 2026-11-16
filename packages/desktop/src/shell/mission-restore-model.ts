export interface RestoreResult {
  success: boolean;
  missionId: string;
  restoredSnapshot: string;
  preRestoreSnapshot: string;
  restoredFilesCount: number;
  deletedFilesCount: number;
  restoredFiles?: string[];
  overwrittenFiles?: string[];
  deletedFiles?: string[];
}

/** Only hidden mission snapshot refs (`refs/opensand/missions/<id>/s-<seq>`) are ever offered for restore. */
const RESTORABLE_REF = /^refs\/opensand\/missions\/[A-Za-z0-9][A-Za-z0-9._-]*\/s-[A-Za-z0-9._-]+$/;

export function isRestorableRef(ref: unknown): ref is string {
  return typeof ref === "string" && RESTORABLE_REF.test(ref) && !ref.includes("..");
}

export interface RestoreConfirmView {
  title: string;
  body: string;
  warning: string;
  confirmLabel: string;
  cancelLabel: string;
}

/**
 * The engine has no dry-run, so the exact file list is only known after a restore. The dialog
 * therefore names the step and states the effect; the result (and its undo) lists the counts.
 */
export function restoreConfirmView(step: { kindLabel: string; summary: string }): RestoreConfirmView {
  return {
    title: "Restore to this step?",
    body: `${step.kindLabel}: ${step.summary}`,
    warning:
      "Files changed since this step are overwritten, and files the mission created after it are deleted. " +
      "Your own untracked and ignored files are left alone. A safety copy is taken first, so you can Undo.",
    confirmLabel: "Restore workspace",
    cancelLabel: "Cancel",
  };
}

export type RestoreErrorKind = "untrusted" | "running" | "failed";

export function classifyRestoreError(err: unknown): { kind: RestoreErrorKind; message: string } {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (/untrusted/i.test(raw)) {
    return { kind: "untrusted", message: "This folder is not trusted yet. Trust the folder, then try again. No files were changed." };
  }
  if (/actively running/i.test(raw)) {
    return { kind: "running", message: "A mission is still running in this folder. Stop it or wait for it to finish, then try again. No files were changed." };
  }
  return { kind: "failed", message: "Restore failed. Your workspace was not changed unless the safety copy says otherwise; try again." };
}

export function restoreSuccessView(r: RestoreResult): { message: string; undoSnapshot?: string } {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const parts = [`${plural(r.restoredFilesCount, "file")} restored`];
  if (r.deletedFilesCount > 0) parts.push(`${plural(r.deletedFilesCount, "file")} deleted`);
  return {
    message: `Workspace restored: ${parts.join(", ")}.`,
    undoSnapshot: isRestorableRef(r.preRestoreSnapshot) ? r.preRestoreSnapshot : undefined,
  };
}

/** Next focusable index for Tab / Shift+Tab inside a dialog with `count` controls; wraps at both ends. */
export function trapFocusIndex(current: number, count: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}
