import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK_DIR = path.join(os.tmpdir(), 'opensand-electron-tests.lock');
const STALE_MS = 120_000;

/**
 * Serialises real-Electron launches across the parallel `node --test` file processes.
 * Electron downloads and unpacks its binary lazily on first launch; two processes doing
 * that at once leave one of them with a half-written framework (dyld "extends beyond
 * end of file", SIGABRT). The lock is a mkdir mutex, so it works across processes.
 */
export async function withElectronLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 240_000;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      break;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > STALE_MS) fs.rmdirSync(LOCK_DIR);
      } catch { /* released by its owner meanwhile */ }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${LOCK_DIR}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.rmdirSync(LOCK_DIR); } catch { /* already gone */ }
  }
}
