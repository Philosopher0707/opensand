import { h, type ComponentChild } from "preact";
import { useEffect, useRef } from "preact/hooks";
import {
  restoreConfirmView,
  groupPreviewFiles,
  trapFocusIndex,
  type PreviewRestoreResult,
} from "./mission-restore-model.js";

export interface RestoreDialogProps {
  step: { kindLabel: string; summary: string };
  preview?: PreviewRestoreResult | null;
  loading?: boolean;
  error?: string | null;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Modal confirm with preview: shows files changed back, recreated, and deleted (deleted first in warning style).
 * Focus starts on Cancel (safe choice), Tab wraps inside, Escape cancels, focus returns to opener.
 */
export function RestoreDialog({
  step,
  preview,
  loading = false,
  error = null,
  busy = false,
  onConfirm,
  onCancel,
}: RestoreDialogProps): ComponentChild {
  const view = restoreConfirmView(step);
  const rootRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

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
    const items = Array.from(rootRef.current?.querySelectorAll?.("button:not([disabled])") ?? []);
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
      h("p", { class: "restore-loading", role: "status" }, "Calculating restore preview…")
    );
  }

  if (error) {
    previewChildren.push(
      h("p", { class: "restore-error", role: "alert" }, error)
    );
  }

  if (isZeroChanges) {
    previewChildren.push(
      h("p", { class: "restore-empty", role: "status" }, "Nothing to restore")
    );
  }

  if (!error && !loading && hasChanges && groups) {
    previewChildren.push(
      h("p", { id: "restoreDialogBody", class: "restore-warning" }, view.warning)
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
            h("span", { class: "restore-section-title" }, count === 1 ? "1 file deleted" : `${count} files deleted`)
          ),
          h(
            "ul",
            { class: "restore-file-list list-deleted", "aria-label": "Files deleted" },
            groups.deletedFiles.map((f) => h("li", { key: f, class: "restore-file-item file-deleted" }, f))
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
            h("span", { class: "restore-section-title" }, count === 1 ? "1 file changed back" : `${count} files changed back`)
          ),
          h(
            "ul",
            { class: "restore-file-list list-overwritten", "aria-label": "Files changed back" },
            groups.overwrittenFiles.map((f) => h("li", { key: f, class: "restore-file-item file-overwritten" }, f))
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
            h("span", { class: "restore-section-title" }, count === 1 ? "1 file recreated" : `${count} files recreated`)
          ),
          h(
            "ul",
            { class: "restore-file-list list-recreated", "aria-label": "Files recreated" },
            groups.recreatedFiles.map((f) => h("li", { key: f, class: "restore-file-item file-recreated" }, f))
          )
        )
      );
    }

    previewChildren.push(h("div", { class: "restore-preview-lists" }, sections));
  }

  const actionButtons: ComponentChild[] = [
    h(
      "button",
      {
        type: "button",
        class: "btn-restore-cancel",
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
          class: "btn-restore-confirm",
          onClick: onConfirm,
          disabled: busy,
        },
        busy ? "Restoring…" : "Confirm restore"
      )
    );
  }

  return h(
    "div",
    { class: "restore-backdrop", onKeyDown },
    h(
      "div",
      {
        class: "restore-dialog",
        role: "alertdialog",
        "aria-modal": "true",
        "aria-labelledby": "restoreDialogTitle",
        "aria-describedby": "restoreDialogBody",
        ref: rootRef,
      },
      h("h3", { id: "restoreDialogTitle", class: "restore-title" }, view.title),
      h("p", { class: "restore-step" }, view.body),
      ...previewChildren,
      h("div", { class: "restore-actions" }, actionButtons)
    )
  );
}
