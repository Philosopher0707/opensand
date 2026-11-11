import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DENIED_SECRET_REL_PATHS } from "./constants.js";

export type SandboxProfileType = "read-only" | "workspace-write" | "full";

export interface GenerateMacosSandboxProfileOptions {
  workspaceRoot: string;
  homeDir?: string;
  tempDir?: string;
  profile?: SandboxProfileType;
  allowNetwork?: boolean;
}

function escapeSchemeString(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function addCanonicalPaths(targetPath: string, pathSet: Set<string>): void {
  const resolved = path.resolve(targetPath);
  pathSet.add(resolved);

  try {
    pathSet.add(fs.realpathSync(resolved));
  } catch {
    try {
      const parent = path.dirname(resolved);
      const realParent = fs.realpathSync(parent);
      pathSet.add(path.join(realParent, path.basename(resolved)));
    } catch {}
  }

  // Handle common macOS symlink prefixes (/tmp <-> /private/tmp, /var <-> /private/var)
  for (const p of Array.from(pathSet)) {
    if (p.startsWith("/tmp/")) {
      pathSet.add("/private" + p);
    } else if (p.startsWith("/private/tmp/")) {
      pathSet.add(p.replace(/^\/private/, ""));
    } else if (p.startsWith("/var/")) {
      pathSet.add("/private" + p);
    } else if (p.startsWith("/private/var/")) {
      pathSet.add(p.replace(/^\/private/, ""));
    }
  }
}

/**
 * Generate an Apple TinyScheme sandbox profile for execution under sandbox-exec.
 */
export function generateMacosSandboxProfile(options: GenerateMacosSandboxProfileOptions): string {
  const {
    workspaceRoot,
    homeDir = os.homedir(),
    tempDir,
    profile = "workspace-write",
    allowNetwork = false,
  } = options;

  if (profile === "full") {
    const lines = ["(version 1)", "(allow default)"];
    if (allowNetwork === false) {
      lines.push("(deny network*)");
    }
    return lines.join("\n") + "\n";
  }

  const lines: string[] = ["(version 1)", "(allow default)"];

  // Network access: disabled by default unless explicitly allowed
  if (!allowNetwork) {
    lines.push("(deny network*)");
  }

  // 1. Deny read access to all paths under homeDir from DENIED_SECRET_REL_PATHS
  const canonicalHomeDirs = new Set<string>();
  if (homeDir) {
    addCanonicalPaths(homeDir, canonicalHomeDirs);
  }

  for (const h of canonicalHomeDirs) {
    for (const relPath of DENIED_SECRET_REL_PATHS) {
      const target = path.join(h, relPath);
      lines.push(`(deny file-read* (subpath "${escapeSchemeString(target)}"))`);
      lines.push(`(deny file-read* (literal "${escapeSchemeString(target)}"))`);
    }
  }

  // 2. Deny all file writes by default
  lines.push("(deny file-write*)");

  // 3. Allow writes for workspace-write profile
  if (profile === "workspace-write") {
    const allowedWritePaths = new Set<string>();

    // 3.1 Workspace root
    addCanonicalPaths(workspaceRoot, allowedWritePaths);

    // 3.2 Temp directory (if explicitly passed or default system temp)
    const effectiveTempDir = tempDir ?? (process.env.TMPDIR || os.tmpdir());
    if (effectiveTempDir) {
      addCanonicalPaths(effectiveTempDir, allowedWritePaths);
    }

    // 3.3 Standard user caches
    for (const h of canonicalHomeDirs) {
      addCanonicalPaths(path.join(h, ".npm"), allowedWritePaths);
      addCanonicalPaths(path.join(h, "Library", "Caches"), allowedWritePaths);
      addCanonicalPaths(path.join(h, ".cache"), allowedWritePaths);
      addCanonicalPaths(path.join(h, ".pnpm-store"), allowedWritePaths);
      addCanonicalPaths(path.join(h, "Library", "pnpm"), allowedWritePaths);
    }

    for (const p of allowedWritePaths) {
      lines.push(`(allow file-write* (subpath "${escapeSchemeString(p)}"))`);
    }
  }

  // 4. Always allow standard devices
  lines.push(
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/zero") (literal "/dev/urandom") (literal "/dev/dtracehelper") (subpath "/dev/fd"))'
  );

  return lines.join("\n") + "\n";
}
