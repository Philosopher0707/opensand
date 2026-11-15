import { memoryWriteNeedsGate, skillWriteNeedsGate } from "@opensand/local-exec-daemon";
import type { ApprovalDecision } from "@opensand/coordinator";

export interface CliApprovalOptions {
  autoApprove: boolean;
  autoApprovePersistent?: boolean;
  isInteractive?: boolean;
  sessionAllowlist?: Set<string>;
  promptApproval?: (toolName: string, args: Record<string, any>) => Promise<ApprovalDecision>;
  onRefusalMessage?: (message: string) => void;
  onAutoApprovedSession?: (toolName: string) => void;
}

export function isPersistentToolCall(toolName: string, args?: Record<string, any>): {
  isPersistent: boolean;
  kind?: "skill" | "memory";
} {
  if (skillWriteNeedsGate(toolName)) {
    return { isPersistent: true, kind: "skill" };
  }
  if (memoryWriteNeedsGate(toolName, args ?? {})) {
    return { isPersistent: true, kind: "memory" };
  }
  return { isPersistent: false };
}

export function allowlistKey(toolName: string, args: Record<string, any>): string {
  if (toolName === "exec_command" && typeof args.command === "string") {
    return `exec_command:${args.command.trim().split(/\s+/)[0] ?? ""}`;
  }
  return toolName;
}

/**
 * Decides whether a tool execution is approved in the CLI.
 *
 * Rules:
 * - With -y (autoApprove), ordinary tool approvals stay automatic.
 * - Persistent changes (skill write/mount and memory write) are NOT auto-approved by -y.
 *   - Interactive: ask the person via promptApproval.
 *   - No approver / non-interactive: refuse with a clear refusal message.
 * - With explicit opt-in (autoApprovePersistent), persistent changes are approved under autoApprove.
 */
export async function decideCliApproval(
  req: { toolName: string; arguments?: Record<string, any> },
  options: CliApprovalOptions
): Promise<boolean> {
  const toolName = req.toolName;
  const args = req.arguments ?? {};
  const { isPersistent, kind } = isPersistentToolCall(toolName, args);

  if (options.autoApprove) {
    if (!isPersistent || options.autoApprovePersistent) {
      return true;
    }

    // Persistent change under -y without explicit opt-in:
    // Skill write/enable and memory write are NOT auto-approved.
    if (!options.isInteractive || !options.promptApproval) {
      const msg = kind === "memory"
        ? "memory writes need your yes; -y does not cover them"
        : "skill writes need your yes; -y does not cover them";
      options.onRefusalMessage?.(msg);
      return false;
    }

    // Interactive: ask the person below
  } else if (options.sessionAllowlist?.has(allowlistKey(toolName, args))) {
    options.onAutoApprovedSession?.(toolName);
    return true;
  }

  if (!options.promptApproval) {
    return false;
  }

  const decision = await options.promptApproval(toolName, args);
  if (decision === "allow_session") {
    options.sessionAllowlist?.add(allowlistKey(toolName, args));
    return true;
  }
  return decision === "allow_once";
}
