// packages/desktop/src/shell/composer-model.ts
// Pure model and state logic for Preact Chat Composer Extras (Phase 5, Row 7).

export interface StagedAttachment {
  name: string;
  size: number;
  type: string;
  localPath?: string;
  previewUrl?: string | null;
  serverId?: string | null;
}

export interface PromptChip {
  id: string;
  title: string;
  desc?: string;
  query: string;
  icon?: string;
}

export interface SlashCommand {
  icon: string;
  title: string;
  desc: string;
  tag: string;
  actionId?: string;
  agentId?: string;
}

export const DEFAULT_PROMPT_CHIPS: PromptChip[] = [
  {
    id: "chip-code-audit",
    title: "Code Health Audit",
    desc: "Comprehensive architectural and quality review",
    query: "Conduct a comprehensive architectural and code health audit of this repository.",
    icon: "🌱",
  },
  {
    id: "chip-inspect-repo",
    title: "Inspect Repository",
    desc: "Analyze codebase files, dependencies & tree",
    query: "Inspect the files in the current repository and summarize the structure.",
    icon: "📁",
  },
  {
    id: "chip-agent-graph",
    title: "Agent Graph Cycles",
    desc: "Autonomous cyclical planning and execution loops",
    query: "Convene an agent graph cycle to plan and execute task decomposition.",
    icon: "⚡",
  },
  {
    id: "chip-security-sentinel",
    title: "Security Sentinel",
    desc: "Audit fail-closed boundaries & tripwires",
    query: "Audit active policy boundaries and workspace sentinel safety tripwires.",
    icon: "🛡️",
  },
];

export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  { icon: "🏗️", title: "/audit", desc: "Conduct architectural & code health audit", tag: "Command", actionId: "audit" },
  { icon: "🧹", title: "/compact", desc: "Auto-compact conversation history", tag: "Command", actionId: "compact" },
  { icon: "⏪", title: "/rollback", desc: "Rollback previous conversation turn", tag: "Command", actionId: "rollback" },
  { icon: "⏪", title: "/rewind", desc: "Rollback previous conversation turn", tag: "Command", actionId: "rollback" },
  { icon: "💡", title: "/btw", desc: "Ask ephemeral side question without context clutter", tag: "Command", actionId: "btw" },
  { icon: "🧠", title: "/habits", desc: "View learned cognitive rules & habits", tag: "Command", actionId: "habits" },
  { icon: "🗑️", title: "/clear", desc: "Clear dialogue session history", tag: "Command", actionId: "clear" },
  { icon: "🩺", title: "/doctor", desc: "Run harness preflight diagnostic health check", tag: "Command", actionId: "doctor" },
  { icon: "❓", title: "/help", desc: "Display available commands and assistance", tag: "Command", actionId: "help" },
];

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function getFileCategory(name: string, type?: string): "image" | "code" | "file" {
  const lower = name.toLowerCase();
  const lowerType = (type || "").toLowerCase();
  if (lowerType.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(lower)) {
    return "image";
  }
  if (
    lowerType.includes("code") ||
    lowerType.includes("javascript") ||
    lowerType.includes("json") ||
    /\.(ts|tsx|js|jsx|py|rs|go|c|cpp|h|java|json|yaml|yml|toml|md|html|css|sh|sql)$/.test(lower)
  ) {
    return "code";
  }
  return "file";
}

export function composePromptWithAttachments(query: string, attachments: StagedAttachment[]): string {
  const trimmed = query.trim();
  if (!attachments || attachments.length === 0) return trimmed;

  const attSummary = attachments
    .map((a) => `[Attachment: ${a.name} (${formatBytes(a.size)}) - ${a.localPath || a.name}]`)
    .join("\n");

  if (!trimmed) {
    return `Please inspect and process the attached context files:\n${attSummary}`;
  }
  return `${trimmed}\n\n${attSummary}`;
}

export function applyPromptChip(currentText: string, chipQuery: string): string {
  const trimmed = currentText.trim();
  if (!trimmed) return chipQuery;
  return `${trimmed} ${chipQuery}`;
}

export interface TriggerMatch {
  triggerChar: "/" | "@" | "#";
  query: string;
  startPos: number;
}

export function detectTrigger(text: string, caretPos: number): TriggerMatch | null {
  if (caretPos < 0 || caretPos > text.length) return null;
  const leftText = text.slice(0, caretPos);
  const match = leftText.match(/(?:^|\s)([/@#])([a-zA-Z0-9_\-]*)$/);
  if (!match) return null;

  const triggerChar = match[1] as "/" | "@" | "#";
  const query = match[2].toLowerCase();
  const fullMatch = match[0];
  const offset = fullMatch.startsWith(" ") ? 1 : 0;
  const startPos = caretPos - fullMatch.length + offset;

  return { triggerChar, query, startPos };
}

export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase().trim();
  if (!q) return commands;
  return commands.filter((cmd) => {
    const title = cmd.title.toLowerCase();
    const desc = cmd.desc.toLowerCase();
    return title.includes(q) || desc.includes(q);
  });
}

export function insertTriggerSelection(
  text: string,
  startPos: number,
  caretPos: number,
  itemTitle: string
): { newText: string; newCaretPos: number } {
  const before = text.slice(0, startPos);
  let after = text.slice(caretPos);
  if (after.startsWith(" ")) {
    after = after.slice(1);
  }
  const insertText = `${itemTitle} `;
  const newText = before + insertText + after;
  const newCaretPos = before.length + insertText.length;
  return { newText, newCaretPos };
}

export type LocalSlashAction = "compact" | "rollback" | "clear" | "doctor";

export interface ParsedSlashCommand {
  action: LocalSlashAction;
}

/** Commands the composer handles locally instead of sending to the model. */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const name = (text || "").trim().toLowerCase();
  if (name === "/compact") return { action: "compact" };
  if (name === "/rollback" || name === "/rewind") return { action: "rollback" };
  if (name === "/clear") return { action: "clear" };
  if (name === "/doctor") return { action: "doctor" };
  return null;
}

/** A fixed, actionable line: raw provider text and stacks never reach the user. */
export function friendlyErrorMessage(err: unknown, fallback: string): string {
  const detail = err instanceof Error ? err.message.toLowerCase() : "";
  if (detail.includes("not found") || detail.includes("enoent")) {
    return `${fallback} The file could not be found.`;
  }
  if (detail.includes("network") || detail.includes("offline") || detail.includes("fetch")) {
    return `${fallback} Check your connection and try again.`;
  }
  return fallback;
}

export type ComposerApprovalMode = "ask" | "auto_edit" | "auto";

/** The composer's mode matches the settings the legacy renderer reads. */
export function composerApprovalMode(settings?: { approvalMode?: unknown; autoApprove?: boolean } | null): ComposerApprovalMode {
  const mode = settings?.approvalMode;
  if (mode === "ask" || mode === "auto_edit" || mode === "auto") return mode;
  return settings?.autoApprove === true ? "auto" : "ask";
}

/** Safe Mode -> Auto-Edit -> Auto-Approve -> Safe Mode, as before. */
export function nextComposerApprovalMode(mode: ComposerApprovalMode): ComposerApprovalMode {
  return mode === "ask" ? "auto_edit" : mode === "auto_edit" ? "auto" : "ask";
}

/** Compact token count for the composer's context badge. */
export function formatContextCount(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "0";
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${m >= 10 ? m.toFixed(1) : m.toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (value >= 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return value.toLocaleString();
}

/** A provider's raw JavaScript error is a failure to report, never chat text. */
export function friendlyChatError(message: string): string {
  const text = String(message || "").trim();
  const fallback = "The agent could not finish that turn. Try again, or use Retry.";
  if (!text || /cannot read propert|is not (?:a function|defined)|typeerror|referenceerror|rangeerror|undefined \(reading|\bat \S+:\d+:\d+/.test(text)) {
    return fallback;
  }
  return text;
}

/** A failed preview is a notice, not a failed attachment: the file is still staged. */
export function previewErrorMessage(name: string): string {
  return `Could not make a preview for ${name}. The file is still attached.`;
}

/** Shorten the redacted support report to something a status line can show. */
export function formatDoctorReport(report: unknown): string {
  const text = report && typeof report === "object" ? (report as { text?: unknown }).text : null;
  if (typeof text !== "string" || !text.trim()) {
    return "Doctor check finished. No details were reported.";
  }
  return text.trim().split("\n").slice(0, 8).join("\n").slice(0, 600);
}

export interface LocalSlashContext {
  compact?: () => Promise<{ compactedTurnCount?: number; originalTokens?: number; compactedTokens?: number }>;
  rollback?: () => Promise<{ removedMessages?: number; remainingMessages?: number }>;
  clearView?: () => void;
  hasSession?: boolean;
  notice: (message: string) => void;
  fetchReport?: () => Promise<{ ok?: boolean; json(): Promise<unknown> }>;
}

/** Runs composer commands locally. Returns false for text that should reach the model. */
export function runLocalSlashCommand(text: string, ctx: LocalSlashContext): Promise<boolean> | false {
  const parsed = parseSlashCommand(text);
  if (!parsed) return false;
  const { notice, hasSession } = ctx;
  return (async () => {
    if (parsed.action === "clear") {
      ctx.clearView?.();
      notice("Conversation cleared. Ask something new to start again.");
      return true;
    }
    if (!hasSession) {
      notice("Select a conversation first.");
      return true;
    }
    try {
      if (parsed.action === "compact") {
        if (!ctx.compact) {
          notice("Compact is not available in this window.");
          return true;
        }
        const res = await ctx.compact();
        notice(`Conversation compacted: ${res?.compactedTurnCount ?? 0} turns, ${res?.originalTokens ?? 0} to ${res?.compactedTokens ?? 0} tokens.`);
        return true;
      }
      if (parsed.action === "rollback") {
        if (!ctx.rollback) {
          notice("Rollback is not available in this window.");
          return true;
        }
        const res = await ctx.rollback();
        notice(`Rolled back ${res?.removedMessages ?? 0} messages. ${res?.remainingMessages ?? 0} remain.`);
        return true;
      }
      const fetcher = ctx.fetchReport ?? (() => fetch("/api/diagnostics"));
      const res = await fetcher();
      if (!res?.ok) {
        notice("Doctor check is unavailable right now.");
        return true;
      }
      notice(formatDoctorReport(await res.json()));
      return true;
    } catch (err) {
      notice(friendlyErrorMessage(err, `The ${parsed.action} command could not be completed. Try again.`));
      return true;
    }
  })();
}
