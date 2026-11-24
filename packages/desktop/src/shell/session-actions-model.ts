// Pure model for the BTW / rollback / compact modals (Phase 5 Row 28).
// Mirrors the legacy renderer/app.js controllers without DOM or bridge code.

export interface BtwAnswer {
  answer?: string;
  [key: string]: unknown;
}

export interface RollbackResult {
  removedMessages?: number;
  remainingMessages?: number;
  [key: string]: unknown;
}

export interface CompactResult {
  originalTokens?: number;
  compactedTokens?: number;
  compactedTurnCount?: number;
  [key: string]: unknown;
}

export const BTW_VALIDATION_MESSAGE = "Please type a question first.";
export const BTW_NO_ANSWER = "No response rendered.";
export const ROLLBACK_DEFAULT_TURNS = 1;
export const COMPACT_DEFAULT_KEEP = 2;

/** Matches the legacy `parseInt(value, 10) || default` behaviour. */
export function parsePositive(raw: string, fallback: number): number {
  return parseInt(raw, 10) || fallback;
}

export function validateBtw(question: string): string | null {
  return question.trim() ? null : BTW_VALIDATION_MESSAGE;
}

export function btwAnswer(result: BtwAnswer): string {
  return result.answer?.trim() || BTW_NO_ANSWER;
}

export function rollbackMessage(result: RollbackResult): string {
  return `Successfully rolled back ${result.removedMessages || 0} messages. Remaining in context: ${result.remainingMessages || 0}.`;
}

export function compactMessage(result: CompactResult): string {
  return `Auto-Compaction succeeded! Original: ~${result.originalTokens} tokens -> Compacted: ~${result.compactedTokens} tokens (condensed ${result.compactedTurnCount} turns).`;
}

export function actionErrorMessage(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}
