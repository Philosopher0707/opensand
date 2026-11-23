// Wiring helpers for desktop actions that had no renderer-side listener.
import { viewHash } from "./navigation-model.js";

export const OPEN_ROLLBACK_EVENT = "opensand:open_rollback";
export const OPEN_COMPACT_EVENT = "opensand:open_compact";

export type SessionAction = "rollback" | "compact";

/** Menu/tray Settings maps to the shell's existing settings view hash. */
export function openSettingsHash(win: { location: { hash: string } }): void {
  win.location.hash = viewHash("settings");
}

/**
 * Inspector events only act on a selected session. Without one the event is ignored
 * so a click can never run rollback/compact against the wrong (or no) conversation.
 */
export function sessionActionForEvent(type: string, hasSession: boolean): SessionAction | null {
  if (!hasSession) return null;
  if (type === OPEN_ROLLBACK_EVENT) return "rollback";
  if (type === OPEN_COMPACT_EVENT) return "compact";
  return null;
}
