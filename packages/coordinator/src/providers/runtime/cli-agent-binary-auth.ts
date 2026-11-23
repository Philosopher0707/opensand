/**
 * Read-only sign-in inspection and credential-home cleanup for CLI binaries.
 * Credentials are never read or returned; only the path and a signed-in flag are exposed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { credentialHome, credentialEnv, type DeviceAuthSpec } from "./device-auth.js";

export interface CliBinaryAuth {
  home: string;
  env(base?: Record<string, string>): Record<string, string>;
  isSignedIn(): boolean;
  clear(): void;
}

/** Wrap a provider spec with the shared credential-home helpers, without spawning the CLI. */
export function wrapCliBinaryAuth(spec: DeviceAuthSpec): CliBinaryAuth {
  const home = credentialHome(spec);
  return {
    home,
    env: (base = {}) => credentialEnv(spec, base),
    isSignedIn() {
      if (!spec.signedInFile) return false;
      try {
        return fs.statSync(path.join(home, spec.signedInFile)).size > 0;
      } catch {
        return false;
      }
    },
    clear() {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch { /* nothing to remove */ }
    },
  };
}
