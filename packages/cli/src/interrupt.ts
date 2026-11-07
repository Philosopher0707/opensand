export const DOUBLE_SIGINT_WINDOW_MS = 1500;

export function shouldExitOnSigInt(
  lastAt: number,
  now: number,
  windowMs = DOUBLE_SIGINT_WINDOW_MS
): boolean {
  return lastAt > 0 && now - lastAt <= windowMs;
}
