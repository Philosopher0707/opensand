export const DOUBLE_SIGINT_WINDOW_MS = 1500;

export function shouldExitOnSigInt(
  lastAt: number,
  now: number,
  windowMs = DOUBLE_SIGINT_WINDOW_MS
): boolean {
  return lastAt > 0 && now - lastAt <= windowMs;
}

export type SigIntAction = "cancel" | "exit" | "arm";

/**
 * Decide what Ctrl+C means in the REPL: cancel the running turn, exit on a
 * second press inside the window, or arm the window on the first press.
 */
export function sigIntAction(
  hasActiveTurn: boolean,
  lastAt: number,
  now: number,
  windowMs = DOUBLE_SIGINT_WINDOW_MS
): SigIntAction {
  if (hasActiveTurn) return "cancel";
  return shouldExitOnSigInt(lastAt, now, windowMs) ? "exit" : "arm";
}
