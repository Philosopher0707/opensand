import type { ToolApprovalRequest } from "../types.js";
import { relativeTime } from "./session-list-model.js";

export type { ToolApprovalRequest };

export interface InboxItemRow {
  id: string;
  toolName: string;
  askingLabel: string;
  targetDescription: string;
  timeLabel: string;
  raw: ToolApprovalRequest;
  active: boolean;
}

export interface InboxEmptyState {
  title: string;
  desc: string;
}

/** Formats a readable target summary from the tool args or request reason. */
export function formatApprovalTarget(req: ToolApprovalRequest): string {
  const args = req.args || {};
  if (req.toolName === "exec_command") {
    if (typeof args.cmd === "string" && args.cmd.trim()) return args.cmd.trim();
    if (typeof args.command === "string" && args.command.trim()) return args.command.trim();
  }
  if (req.toolName === "write_file" || req.toolName === "edit_file") {
    if (typeof args.path === "string" && args.path.trim()) return args.path.trim();
    if (typeof args.file === "string" && args.file.trim()) return args.file.trim();
    if (typeof args.target_file === "string" && args.target_file.trim()) return args.target_file.trim();
  }
  if (req.toolName === "folder.trust") {
    if (typeof args.folder === "string" && args.folder.trim()) return `Trust folder: ${args.folder.trim()}`;
  }
  if (req.reason && req.reason.trim()) {
    return req.reason.trim();
  }
  if (typeof args.cmd === "string" && args.cmd.trim()) return args.cmd.trim();
  if (typeof args.path === "string" && args.path.trim()) return args.path.trim();
  if (typeof args.url === "string" && args.url.trim()) return args.url.trim();

  const keys = Object.keys(args);
  if (keys.length > 0) {
    const firstVal = args[keys[0]];
    if (typeof firstVal === "string" && firstVal.trim()) {
      return `${keys[0]}: ${firstVal.trim()}`;
    }
    return `${keys.join(", ")}`;
  }

  return req.toolName || "Action";
}

export function formatAsking(req: ToolApprovalRequest): string {
  return req.toolName || "Agent";
}

/** Sorts approvals newest first; ties broken by approvalId. */
export function sortApprovals(approvals: ToolApprovalRequest[]): ToolApprovalRequest[] {
  return [...approvals].sort((a, b) => {
    const diff = (b.timestamp || 0) - (a.timestamp || 0);
    if (diff !== 0) return diff;
    return (a.approvalId || "").localeCompare(b.approvalId || "");
  });
}

export function formatTimestamp(ts: number | string | undefined | null, now: number): string {
  if (!ts) return "";
  const iso = typeof ts === "number" ? new Date(ts).toISOString() : ts;
  return relativeTime(iso, now);
}

export function toInboxRow(
  req: ToolApprovalRequest,
  timeLabel: string,
  activeId?: string | null
): InboxItemRow {
  return {
    id: req.approvalId,
    toolName: req.toolName || "Tool",
    askingLabel: formatAsking(req),
    targetDescription: formatApprovalTarget(req),
    timeLabel,
    raw: req,
    active: Boolean(activeId && req.approvalId === activeId),
  };
}

export function inboxEmptyState(): InboxEmptyState {
  return {
    title: "Nothing needs you",
    desc: "When actions require your authorization, they will appear here.",
  };
}

export function formatBadgeCount(count: number): string {
  return String(Math.max(0, count));
}

export type ListKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** Roving-focus index for a vertical list; clamps at both ends. */
export function nextIndex(current: number, key: string, length: number): number {
  if (length <= 0) return -1;
  const last = length - 1;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : Math.min(current + 1, last);
    case "ArrowUp":
      return current < 0 ? last : Math.max(current - 1, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return current;
  }
}
