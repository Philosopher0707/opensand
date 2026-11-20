/**
 * Terminate an engine child and every descendant it spawned.
 *
 * Runtimes spawn with `detached` on POSIX so the child leads its own process
 * group; killing the group prevents orphaned CLI helpers on cancel or quit.
 * Windows has no negative-pid kill, so it falls back to the direct child.
 */

import type { ChildProcess } from 'node:child_process';

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group may already be gone; fall back to the direct child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

export function killProcessTree(child: ChildProcess, graceMs = 5_000): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalTree(child, 'SIGTERM');
  const timer = setTimeout(() => signalTree(child, 'SIGKILL'), graceMs);
  timer.unref?.();
}
