import * as fs from 'node:fs';

export interface Closable {
  close?: () => Promise<void>;
  /** Servers (DesktopServer, DesktopApp) shut down with stop() instead of close(). */
  stop?: () => Promise<void>;
}

/**
 * Closes everything that may still write into `dirs` (bridges, servers, daemons), in order,
 * and only then removes the directories. Awaiting the shutdown is the whole fix for the
 * ENOTEMPTY teardown race: a plain rm must succeed once nothing is writing any more.
 * A close() that throws still lets the directories go, and its error is rethrown.
 */
export async function closeThenRemove(closables: Array<Closable | undefined>, ...dirs: string[]): Promise<void> {
  try {
    for (const closable of closables) {
      if (closable?.close) await closable.close();
      else await closable?.stop?.();
    }
  } finally {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
