/**
 * Turn running helpers (OpenBot toolkit parity: leases, history sanitation).
 * Extracted from coordinator as pure functions; orchestration stays in coordinator.
 */
import type { ChatMessage } from "@opensand/shared";

/** Sanitize message history for model consumption: drop empty tool results, cap turns. */
export function sanitizeHistory(messages: ChatMessage[], maxMessages = 200): ChatMessage[] {
  const cleaned = messages.filter((m) => {
    if (m.role === "tool" && !m.content?.trim()) return false;
    if (m.role === "system" && m.content?.includes("<historical_context_summary>") === false && m.content === "") return false;
    return true;
  });
  return cleaned.length > maxMessages ? cleaned.slice(-maxMessages) : cleaned;
}

/** A simple lease: marks a tool call as in-flight so double-execution is detectable. */
export class ToolLeaseTracker {
  private active = new Map<string, number>();
  acquire(toolCallId: string): boolean {
    if (this.active.has(toolCallId)) return false;
    this.active.set(toolCallId, Date.now());
    return true;
  }
  release(toolCallId: string): void { this.active.delete(toolCallId); }
  has(toolCallId: string): boolean { return this.active.has(toolCallId); }
}
