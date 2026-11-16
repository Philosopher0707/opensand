import { h, type ComponentChild } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  forkConfirmView,
  type ForkConfirmView,
} from "./mission-fork-model.js";
import {
  groupPreviewFiles,
  trapFocusIndex,
  type PreviewRestoreResult,
} from "./mission-restore-model.js";

export interface ForkDialogProps {
  step: { kindLabel: string; summary: string; seq?: number | string };
  preview?: PreviewRestoreResult | null;
  loading?: boolean;
  error?: string | null;
  recoveryHint?: string | null;
  busy?: boolean;
  onConfirm: (options: { newInstruction?: string; newTitle?: string }) => void;
  onCancel: () => void;
}

/**
 * Modal confirm with preview and optional instructions:
 * Shows files changed back, recreated, and deleted (deleted first in warning style).
 * Focus starts on Cancel (safe choice), Tab wraps inside, Escape cancels, focus returns to opener.
 */
export function ForkDialog({
  step,
  preview,
  loading = false,
  error = null,
  recoveryHint = null,
  busy = false,
  onConfirm,
  onCancel,
}: ForkDialogProps): ComponentChild {
  const view: ForkConfirmView = forkConfirmView(step);
  const rootRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    const opener = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    cancelRef.current?.focus?.();
    return () => opener?.focus?.();
  }, []);

  const onKeyDown = (e: any) => {
    if (e.key === "Escape" && !busy) {
      e.preventDefault?.();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const items = Array.from(
      rootRef.current?.querySelectorAll?.("button:not([disabled]), textarea:not([disabled]), input:not([disabled])") ?? []
    );
    if (items.length === 0) {
      e.preventDefault?.();
      return;
    }
    const curIdx = items.indexOf(typeof document !== "undefined" ? (document.activeElement as HTMLElement) : (null as any));
    const next = trapFocusIndex(curIdx, items.length, Boolean(e.shiftKey));
    e.preventDefault?.();
    (items[next] as HTMLElement)?.focus?.();
  };

  const groups = preview ? groupPreviewFiles(preview) : null;
  const hasChanges = Boolean(groups && groups.totalChanges > 0);
  const isZeroChanges = Boolean(!error && !loading && groups && groups.totalChanges === 0);

  const previewChildren: ComponentChild[] = [];

  if (loading) {
    previewChildren.push(
      h("p", { class: "fork-loading restore-loading", role: "status" }, "Calculating fork preview…")
    );
  }

  if (error) {
    const errorContents: ComponentChild[] = [
      h("span", null, error),
    ];
    if (recoveryHint) {
      errorContents.push(
        h("p", { class: "fork-recovery-hint" }, recoveryHint)
      );
    }
    previewChildren.push(
      h("div", { class: "fork-error restore-error", role: "alert" }, errorContents)
    );
  }

  if (isZeroChanges) {
    previewChildren.push(
      h("p", { class: "fork-empty restore-empty", role: "status" }, "Nothing to restore")
    );
  }

  if (!error && !loading && hasChanges && groups) {
    previewChildren.push(
      h("p", { id: "forkDialogBody", class: "fork-warning restore-warning" }, view.warning)
    );

    const sections: ComponentChild[] = [];

    // Deleted files shown FIRST in warning style
    if (groups.deletedFiles.length > 0) {
      const count = groups.deletedFiles.length;
      sections.push(
        h(
          "div",
          { class: "restore-section restore-section-deleted" },
          h(
            "div",
            { class: "restore-section-header" },
            h("span", { class: "restore-count-badge badge-deleted" }, String(count)),
            h(
              "span",
              { class: "restore-section-title" },
              count === 1 ? "1 file deleted" : `${count} files deleted`
            )
          ),
          h(
            "ul",
            { class: "restore-file-list list-deleted", "aria-label": "Files deleted" },
            groups.deletedFiles.map((f) =>
              h("li", { key: f, class: "restore-file-item file-deleted" }, f)
            )
          )
        )
      );
    }

    // Overwritten files (files changed back)
    if (groups.overwrittenFiles.length > 0) {
      const count = groups.overwrittenFiles.length;
      sections.push(
        h(
          "div",
          { class: "restore-section restore-section-overwritten" },
          h(
            "div",
            { class: "restore-section-header" },
            h("span", { class: "restore-count-badge badge-overwritten" }, String(count)),
            h(
              "span",
              { class: "restore-section-title" },
              count === 1 ? "1 file changed back" : `${count} files changed back`
            )
          ),
          h(
            "ul",
            { class: "restore-file-list list-overwritten", "aria-label": "Files changed back" },
            groups.overwrittenFiles.map((f) =>
              h("li", { key: f, class: "restore-file-item file-overwritten" }, f)
            )
          )
        )
      );
    }

    // Recreated files
    if (groups.recreatedFiles.length > 0) {
      const count = groups.recreatedFiles.length;
      sections.push(
        h(
          "div",
          { class: "restore-section restore-section-recreated" },
          h(
            "div",
            { class: "restore-section-header" },
            h("span", { class: "restore-count-badge badge-recreated" }, String(count)),
            h(
              "span",
              { class: "restore-section-title" },
              count === 1 ? "1 file recreated" : `${count} files recreated`
            )
          ),
          h(
            "ul",
            { class: "restore-file-list list-recreated", "aria-label": "Files recreated" },
            groups.recreatedFiles.map((f) =>
              h("li", { key: f, class: "restore-file-item file-recreated" }, f)
            )
          )
        )
      );
    }

    previewChildren.push(h("div", { class: "restore-preview-lists" }, sections));
  }

  // Instruction input field: always available when not in pure error state
  if (!error && !loading && hasChanges) {
    previewChildren.push(
      h(
        "div",
        { class: "fork-instruction-field" },
        h("label", { for: "forkInstructionInput", class: "fork-instruction-label" }, "New instruction (optional):"),
        h("textarea", {
          id: "forkInstructionInput",
          class: "fork-instruction-input",
          placeholder: "Enter optional new instructions for the forked mission…",
          rows: 3,
          value: instruction,
          disabled: busy,
          onInput: (e: any) => setInstruction(e.target?.value ?? ""),
        })
      )
    );
  }

  const actionButtons: ComponentChild[] = [
    h(
      "button",
      {
        type: "button",
        class: "btn-fork-cancel btn-restore-cancel",
        ref: cancelRef,
        onClick: onCancel,
        disabled: busy,
      },
      "Cancel"
    ),
  ];

  if (!error && !loading && hasChanges) {
    actionButtons.push(
      h(
        "button",
        {
          type: "button",
          class: "btn-fork-confirm btn-restore-confirm",
          onClick: () => {
            const trimmed = instruction.trim();
            onConfirm({ newInstruction: trimmed.length > 0 ? trimmed : undefined });
          },
          disabled: busy,
        },
        busy ? "Forking…" : "Confirm fork"
      )
    );
  }

  return h(
    "div",
    { class: "fork-backdrop restore-backdrop", onKeyDown },
    h(
      "div",
      {
        class: "fork-dialog restore-dialog",
        role: "alertdialog",
        "aria-modal": "true",
        "aria-labelledby": "forkDialogTitle",
        "aria-describedby": "forkDialogBody",
        ref: rootRef,
      },
      h("h3", { id: "forkDialogTitle", class: "fork-title restore-title" }, view.title),
      h("p", { class: "fork-step restore-step" }, view.body),
      ...previewChildren,
      h("div", { class: "fork-actions restore-actions" }, actionButtons)
    )
  );
}
