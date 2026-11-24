// Pure model for the renderer boot sequence (Phase 5 Row 29).
// Derives the order and the persisted-state validation used by Shell on startup.

export const ACTIVE_AGENT_KEY = "opensand-active-agent";
export const SESSION_KEY = "opensand-session-id";

export interface BootAgent {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface BootSession {
  id: string;
  title?: string;
  [key: string]: unknown;
}

export type BootStatus = "loading" | "ready" | "error";

/**
 * The legacy shell probes /api/settings only in the browser (Electron owns auth over IPC)
 * and only when no session token is present.
 */
export function needsAuthProbe(isElectron: boolean, token?: string | null): boolean {
  return !isElectron && !token;
}

/** A saved id that is no longer live must be dropped so the next boot cannot restore a ghost. */
export function resolveActiveAgent(savedId: string | null, live: BootAgent[]): {
  agent: BootAgent | null;
  clearPersisted: boolean;
} {
  if (!savedId) return { agent: null, clearPersisted: false };
  const agent = live.find((item) => item.id === savedId);
  return agent ? { agent, clearPersisted: false } : { agent: null, clearPersisted: true };
}

export function resolveSessionRestore(savedId: string | null, live: BootSession[]): {
  sessionId: string | null;
  clearPersisted: boolean;
} {
  if (!savedId) return { sessionId: null, clearPersisted: false };
  return live.some((item) => item.id === savedId)
    ? { sessionId: savedId, clearPersisted: false }
    : { sessionId: null, clearPersisted: true };
}

export function bootStatus(loading: boolean, failed: boolean): BootStatus {
  if (loading) return "loading";
  if (failed) return "error";
  return "ready";
}

/** Stable phase order: auth check, then the shared lists, then the persisted selections. */
export const BOOT_PHASES = ["auth", "agents", "sessions", "restore", "ready"] as const;
export type BootPhase = (typeof BOOT_PHASES)[number];
