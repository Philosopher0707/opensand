/**
 * Bounded idle reaper for warm engine children.
 *
 * One timer per runtime instance; a session is closed only when it has no
 * pending turn. All intervals are bounded and unref'd so tests and shutdown
 * never hang on the timer.
 */

export interface IdleReapable {
  lastUsedAt: number;
  pendingTurn?: unknown;
  stopped?: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function startIdleReaper<T extends IdleReapable>(
  sessions: Map<string, T>,
  close: (threadId: string) => void,
): () => void {
  const idleMs = envInt("OPENSAND_ENGINE_IDLE_MS", 10 * 60 * 1000);
  const tickMs = envInt("OPENSAND_ENGINE_REAP_TICK_MS", 60 * 1000);
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [threadId, session] of sessions) {
      if (session.pendingTurn || session.stopped) continue;
      if (now - session.lastUsedAt >= idleMs) close(threadId);
    }
  }, tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
