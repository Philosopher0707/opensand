import { useEffect, useRef } from "preact/hooks";
import { restoreConfirmView, trapFocusIndex } from "../../../src/shell/mission-restore-model";

export interface RestoreDialogProps {
  step: { kindLabel: string; summary: string };
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Modal confirm: focus starts on Cancel (the safe choice), Tab wraps inside, Escape cancels, focus returns to the opener. */
export function RestoreDialog({ step, busy, error, onConfirm, onCancel }: RestoreDialogProps) {
  const view = restoreConfirmView(step);
  const rootRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !busy) {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const next = trapFocusIndex(items.indexOf(document.activeElement as HTMLElement), items.length, e.shiftKey);
    e.preventDefault();
    items[next]?.focus();
  };

  return (
    <div class="restore-backdrop" onKeyDown={onKeyDown}>
      <div
        class="restore-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="restoreDialogTitle"
        aria-describedby="restoreDialogBody"
        ref={rootRef}
      >
        <h3 id="restoreDialogTitle" class="restore-title">{view.title}</h3>
        <p class="restore-step">{view.body}</p>
        <p id="restoreDialogBody" class="restore-warning">{view.warning}</p>
        {error && <p class="restore-error" role="alert">{error}</p>}
        <div class="restore-actions">
          <button type="button" class="btn-restore-cancel" ref={cancelRef} onClick={onCancel} disabled={busy}>{view.cancelLabel}</button>
          <button type="button" class="btn-restore-confirm" onClick={onConfirm} disabled={busy}>
            {busy ? "Restoring…" : view.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
