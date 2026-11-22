// OpenSand approval modes — WorkMate-style simplification
// Ported from WorkMate permissions.js pattern.
// Decides on what an action DOES (its effect), never on a tool's name alone.
//
//   ask       every change asks (the "always allow X in this task" button still works) — default
//   auto_edit file edits, sandboxed shell commands, isolated sub-agents and sandboxed engine runs proceed
//   auto      everything above plus unsandboxed shell, web, browser, memory, connectors, git commits

export const APPROVAL_MODES = ["ask", "auto_edit", "auto"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const APPROVAL_LABELS: Record<ApprovalMode, string> = {
  ask: "Ask every time",
  auto_edit: "Auto-edit",
  auto: "Auto-approve",
};

// What an action does. Tools and engine drivers name one of these.
export const EFFECTS: Record<string, string> = {
  read: "reads only",
  edit: "edits files in the workspace (recorded, can be undone)",
  shell: "runs a command in the sandbox (writes only in the workspace)",
  delegate: "starts sub-agents in their own git worktree",
  engine_run: "lets an engine work on this task",
  shell_outside: "runs a command outside the sandbox, as your user",
  network: "opens a web address or sends a search",
  browser: "acts in the browser window",
  memory: "changes long-term memory",
  external: "acts through a connector (outside this computer)",
  vcs: "commits in git",
  control: "controls the Mac (screen, mouse, keyboard)",
  spend: "spends money",
  self: "changes OpenSand itself (skills, connectors, automations)",
};

export const NEVER_AUTO = new Set(["control", "spend", "self"]);
export const AUTO_EDIT = new Set(["read", "edit", "shell", "delegate"]);
export const SHELLS = new Set(["shell", "shell_outside"]);

export interface ApprovalCheckRequest {
  name?: string;
  effect?: string;
  note?: string;
  sandboxed?: boolean;
  args?: Record<string, unknown>;
}

export function approvalModeOf(
  session?: { approvalMode?: unknown } | null,
  config: { approvalMode?: unknown; autoApprove?: boolean } = {},
): ApprovalMode {
  const m = session?.approvalMode || config?.approvalMode;
  if (typeof m === "string" && (APPROVAL_MODES as readonly string[]).includes(m)) {
    return m as ApprovalMode;
  }
  if (config?.autoApprove === true) {
    return "auto";
  }
  return "ask";
}

/** The effect a tool call has: the tool's own declaration (a value or a function of the arguments); unknown otherwise. */
export function effectOf(tool: any, args: Record<string, unknown> = {}): string {
  const e = typeof tool?.effect === "function" ? tool.effect(args) : tool?.effect;
  if (e && EFFECTS[e]) return e;
  return tool?.access === "read" ? "read" : "unknown";
}

/** Whether `mode` lets this approval request through without asking. Decided on req.effect; unknown is asked. */
export function autoAllows(mode: string, req: ApprovalCheckRequest = {}): boolean {
  if (mode !== "auto_edit" && mode !== "auto") return false;
  const effect = req.effect;
  if (!effect || !EFFECTS[effect] || NEVER_AUTO.has(effect)) return false;
  if (req.note && SHELLS.has(effect)) return false; // web content was read earlier in this run
  // An engine that cannot ask per action asks once per run: Auto-edit allows it only when the engine's work is held to
  // the folder by a sandbox; otherwise it acts as your user.
  if (effect === "engine_run") return mode === "auto" || req.sandboxed === true;
  if (mode === "auto_edit") return AUTO_EDIT.has(effect);
  return true;
}
