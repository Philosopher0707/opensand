import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Environment for a real-Electron launch that must never touch the owner's data.
 * The app resolves its state dir as `os.homedir()/.opensand`, so a launch under the real
 * HOME reads, migrates and writes the owner's live state (and token). Every test that
 * spawns Electron builds its env here, with HOME and USERPROFILE pointing at a temp dir.
 */
export function hermeticElectronEnv(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // Run as a real Electron GUI process, not as Node.
  delete env.ELECTRON_RUN_AS_NODE;
  // Automated launches must never show a window, add a Dock icon or steal focus.
  // main.ts reads this to create the window hidden and skip the tray/Dock activation.
  env.OPENSAND_HIDDEN_WINDOW = '1';
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}

export function makeTempHome(prefix = 'opensand-home-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
