import { h, type ComponentChild } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import type { ToolApprovalRequest } from "./inbox-model.js";
import {
  sortApprovals,
  toInboxRow,
  inboxEmptyState,
  nextIndex,
  formatTimestamp,
  formatBadgeCount,
  type InboxItemRow,
} from "./inbox-model.js";

export type ApprovalAction = "approve_once" | "always_allow" | "reject";

export interface ShellDataWithApprovals {
  listPendingApprovals(): Promise<ToolApprovalRequest[]>;
  onApprovalChange?(callback: () => void): () => void;
  /** Answers one approval, as the legacy approval modal does. Optional: without it the list is read-only. */
  approveTool?(approvalId: string, decision: { action: ApprovalAction; epoch: number }): Promise<unknown>;
}

export interface InboxProps {
  data: ShellDataWithApprovals;
  now?: () => number;
  onSelectApproval?: (approval: ToolApprovalRequest) => void;
  /** Bump to reload the list, e.g. after an answer given outside the Inbox. */
  refreshKey?: number;
  /** Called after an answer given in the Inbox, so the caller can close any detail it shows for it. */
  onDecided?: () => void;
}

const DECISIONS: Array<{ action: ApprovalAction; label: string; class: string }> = [
  { action: "approve_once", label: "Approve Once", class: "btn-primary" },
  { action: "always_allow", label: "Always Allow", class: "btn-secondary" },
  { action: "reject", label: "Reject", class: "btn-ghost" },
];

export interface ApprovalDecisionButtonsProps {
  data: ShellDataWithApprovals;
  req: ToolApprovalRequest;
  onDecided?: () => void;
}

/** Approve Once / Always Allow / Reject for one request. Renders nothing when the data has no approveTool. */
export function ApprovalDecisionButtons({ data, req, onDecided }: ApprovalDecisionButtonsProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data.approveTool) return null;

  const decide = (action: ApprovalAction) => (e: Event) => {
    // The buttons sit inside a selectable row: a click here must not also toggle the row.
    e.stopPropagation();
    if (pending || !data.approveTool) return;
    setPending(true);
    setError(null);
    data
      .approveTool(req.approvalId, { action, epoch: req.epoch })
      .then((res) => {
        if (res && (res as { success?: boolean }).success === false) throw new Error("not pending");
        onDecided?.();
      })
      .catch(() => setError("This approval is no longer pending, or the answer did not reach the app."))
      .finally(() => setPending(false));
  };

  return h(
    "div",
    { class: "approval-decision" },
    h(
      "div",
      { class: "inbox-decision-row", role: "group", "aria-label": "Answer this approval" },
      ...DECISIONS.map((d) =>
        h(
          "button",
          {
            type: "button",
            class: `btn btn-sm ${d.class}`,
            disabled: pending,
            onClick: decide(d.action),
          },
          d.label
        )
      )
    ),
    error ? h("div", { class: "inbox-error", role: "alert" }, h("span", null, error)) : null
  );
}

export interface InboxBadgeProps {
  pendingCount: number;
  urgent?: boolean;
  onSelectInbox?: () => void;
  collapsed?: boolean;
}

export function InboxBadge({
  pendingCount,
  urgent = pendingCount > 0,
  onSelectInbox,
  collapsed,
}: InboxBadgeProps) {
  const count = Math.max(0, pendingCount);
  return h(
    "button",
    {
      type: "button",
      class: "inbox-badge",
      onClick: onSelectInbox,
      "aria-label": `NEEDS YOU: ${count} pending approval${count === 1 ? "" : "s"}`,
      "aria-expanded": collapsed !== undefined ? !collapsed : undefined,
    },
    h("span", { class: "inbox-badge-title" }, "NEEDS YOU"),
    h(
      "span",
      {
        class: `inbox-badge-count ${urgent && count > 0 ? "has-pending" : ""}`,
      },
      formatBadgeCount(count)
    )
  );
}

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; approvals: ToolApprovalRequest[] };

export function Inbox({ data, now, onSelectApproval, refreshKey = 0, onDecided }: InboxProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    setLoad({ state: "loading" });
    data
      .listPendingApprovals()
      .then((res) => {
        if (mounted) setLoad({ state: "ready", approvals: Array.isArray(res) ? res : [] });
      })
      .catch(() => {
        if (mounted) setLoad({ state: "error" });
      });

    const cleanup = data.onApprovalChange?.(() => {
      if (mounted) {
        data
          .listPendingApprovals()
          .then((res) => {
            if (mounted) setLoad({ state: "ready", approvals: Array.isArray(res) ? res : [] });
          })
          .catch(() => {});
      }
    });

    return () => {
      mounted = false;
      cleanup?.();
    };
  }, [data, attempt, refreshKey]);

  const currentTime = now ? now() : Date.now();
  const approvals = load.state === "ready" ? sortApprovals(load.approvals) : [];
  const rows: InboxItemRow[] = approvals.map((req) =>
    toInboxRow(req, formatTimestamp(req.timestamp, currentTime), activeId)
  );

  const pendingCount = load.state === "ready" ? approvals.length : 0;

  const selectItem = (row: InboxItemRow) => {
    setActiveId(row.id);
    setExpandedId((prev) => (prev === row.id ? null : row.id));
    onSelectApproval?.(row.raw);

    // If existing shell approval modal is present in DOM, populate and open it
    if (typeof document !== "undefined") {
      const modal = document.getElementById("approvalModal");
      if (modal) {
        const toolNameEl = document.getElementById("approvalToolName");
        if (toolNameEl) toolNameEl.textContent = row.raw.toolName;
        const argsBoxEl = document.getElementById("approvalArgsBox");
        if (argsBoxEl) argsBoxEl.textContent = JSON.stringify(row.raw.args, null, 2);
        const reasonEl = document.getElementById("approvalReason");
        const reasonRowEl = document.getElementById("approvalReasonRow");
        if (reasonEl) {
          reasonEl.textContent = row.raw.reason || "";
          if (reasonRowEl) reasonRowEl.style.display = row.raw.reason ? "" : "none";
        }
        modal.classList.remove("hidden");
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Enter or Space on a decision button activates the button, not the row.
    if ((e.target as HTMLElement | null)?.tagName === "BUTTON") return;
    if (e.key === "Enter" || e.key === " ") {
      const row = rows[focusIdx];
      if (row) {
        e.preventDefault();
        selectItem(row);
      }
      return;
    }
    const next = nextIndex(focusIdx, e.key, rows.length);
    if (next !== focusIdx || ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      setFocusIdx(next);
      listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[next]?.focus();
    }
  };

  const empty = inboxEmptyState();

  const renderContent = () => {
    if (load.state === "loading") {
      return h(
        "div",
        { class: "inbox-loading", role: "status" },
        h("span", null, "Loading approvals…")
      );
    }
    if (load.state === "error") {
      return h(
        "div",
        { class: "inbox-error", role: "alert" },
        h("span", null, "Couldn't load approvals"),
        h(
          "button",
          {
            type: "button",
            class: "btn-retry",
            onClick: () => setAttempt((n) => n + 1),
            "aria-label": "Retry loading approvals",
          },
          "Retry"
        )
      );
    }
    if (load.state === "ready" && rows.length === 0) {
      return h(
        "div",
        { class: "inbox-empty", role: "status" },
        h("div", { class: "inbox-empty-title" }, empty.title),
        h("div", { class: "inbox-empty-desc" }, empty.desc)
      );
    }
    return h(
      "div",
      {
        role: "listbox",
        "aria-label": "Pending approvals",
        class: "inbox-list",
        ref: listRef,
        onKeyDown,
      },
      ...rows.map((row, i) => {
        const isExpanded = expandedId === row.id;
        const itemChildren: ComponentChild[] = [
          h(
            "div",
            { class: "inbox-item-header" },
            h("span", { class: "inbox-item-asking", title: row.toolName }, row.askingLabel),
            row.timeLabel ? h("span", { class: "inbox-item-time" }, row.timeLabel) : null
          ),
          h("div", { class: "inbox-item-wants", title: row.targetDescription }, row.targetDescription),
        ];

        if (isExpanded) {
          const detailChildren: ComponentChild[] = [
            h(
              "div",
              { class: "inbox-detail-row" },
              h("strong", null, "Tool: "),
              h("code", null, row.raw.toolName)
            ),
          ];
          if (row.raw.reason) {
            detailChildren.push(
              h(
                "div",
                { class: "inbox-detail-row" },
                h("strong", null, "Reason: "),
                h("span", null, row.raw.reason)
              )
            );
          }
          detailChildren.push(
            h("div", { class: "inbox-detail-row" }, h("strong", null, "Arguments:")),
            h("pre", { class: "inbox-args-box" }, JSON.stringify(row.raw.args, null, 2)),
            h(
              "div",
              { class: "inbox-detail-meta" },
              h("span", null, `Epoch: ${row.raw.epoch}`),
              h("span", null, `ID: ${row.id}`)
            ),
            h(ApprovalDecisionButtons, {
              data,
              req: row.raw,
              onDecided: () => {
                setExpandedId(null);
                setActiveId(null);
                setAttempt((n) => n + 1);
                onDecided?.();
              },
            })
          );

          itemChildren.push(
            h("div", { class: "inbox-item-details", id: `inbox-details-${row.id}` }, ...detailChildren)
          );
        }

        return h(
          "div",
          {
            key: row.id,
            role: "option",
            "aria-selected": row.active,
            "aria-expanded": isExpanded,
            tabIndex: i === focusIdx ? 0 : -1,
            class: `inbox-item ${row.active ? "active" : ""}`,
            "data-approval-id": row.id,
            onClick: () => {
              setFocusIdx(i);
              selectItem(row);
            },
            onFocus: () => setFocusIdx(i),
          },
          ...itemChildren
        );
      })
    );
  };

  return h(
    "section",
    { class: "inbox-root", "aria-label": "Inbox" },
    h(
      "div",
      { class: "inbox-header" },
      h(InboxBadge, {
        pendingCount,
        urgent: pendingCount > 0,
        collapsed,
        onSelectInbox: () => setCollapsed((c) => !c),
      })
    ),
    !collapsed ? h("div", { class: "inbox-content" }, renderContent()) : null
  );
}
