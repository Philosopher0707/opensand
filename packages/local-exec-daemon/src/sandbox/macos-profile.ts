import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type SandboxProfileType = "read-only" | "workspace-write" | "full";

export interface GenerateMacosSandboxProfileOptions {
  workspaceRoot: string;
  profile: SandboxProfileType;
  allowNetwork?: boolean;
}

function escapeSchemeString(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Generate an Apple TinyScheme sandbox profile for execution under sandbox-exec.
 */
export function generateMacosSandboxProfile(options: {
  workspaceRoot: string;
  profile: "read-only" | "workspace-write" | "full";
  allowNetwork?: boolean;
}): string {
  const { workspaceRoot, profile, allowNetwork } = options;

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

  // Deny read access to sensitive user secrets & shell initialization files
  const homeDirs = new Set<string>();
  const home = os.homedir();
  if (home) {
    homeDirs.add(home);
    try {
      homeDirs.add(fs.realpathSync(home));
    } catch {}
  }

  for (const h of homeDirs) {
    lines.push(`(deny file-read* (subpath "${escapeSchemeString(path.join(h, ".ssh"))}"))`);
    lines.push(`(deny file-read* (literal "${escapeSchemeString(path.join(h, ".ssh"))}"))`);
    lines.push(`(deny file-read* (subpath "${escapeSchemeString(path.join(h, ".opensand", "vault"))}"))`);
    lines.push(`(deny file-read* (literal "${escapeSchemeString(path.join(h, ".opensand", "vault"))}"))`);
    lines.push(`(deny file-read* (literal "${escapeSchemeString(path.join(h, ".bashrc"))}"))`);
    lines.push(`(deny file-read* (literal "${escapeSchemeString(path.join(h, ".bash_profile"))}"))`);
    lines.push(`(deny file-read* (literal "${escapeSchemeString(path.join(h, ".zshrc"))}"))`);
    lines.push(`(deny file-read* (literal "${escapeSchemeString(path.join(h, ".profile"))}"))`);
    lines.push(`(deny file-read* (literal "${escapeSchemeString(path.join(h, ".zshenv"))}"))`);
    lines.push(`(deny file-read* (literal "${escapeSchemeString(path.join(h, ".zprofile"))}"))`);
  }

  // Deny all file writes by default
  lines.push("(deny file-write*)");

  // Allow writes inside target workspace directory for workspace-write profile
  if (profile === "workspace-write") {
    const resolvedWorkspace = path.resolve(workspaceRoot);
    const allowedWritePaths = new Set<string>();
    allowedWritePaths.add(resolvedWorkspace);

    // Canonicalize workspaceRoot using fs.realpathSync to handle symlinks (e.g. /tmp -> /private/tmp)
    try {
      allowedWritePaths.add(fs.realpathSync(resolvedWorkspace));
    } catch {
      try {
        const parent = path.dirname(resolvedWorkspace);
        const realParent = fs.realpathSync(parent);
        allowedWritePaths.add(path.join(realParent, path.basename(resolvedWorkspace)));
      } catch {}
    }

    // Explicitly handle canonical macOS aliases (/tmp <-> /private/tmp, /var <-> /private/var)
    for (const p of Array.from(allowedWritePaths)) {
      if (p.startsWith("/tmp/")) {
        allowedWritePaths.add("/private" + p);
      } else if (p.startsWith("/private/tmp/")) {
        allowedWritePaths.add(p.replace(/^\/private/, ""));
      } else if (p.startsWith("/var/")) {
        allowedWritePaths.add("/private" + p);
      } else if (p.startsWith("/private/var/")) {
        allowedWritePaths.add(p.replace(/^\/private/, ""));
      }
    }

    for (const p of allowedWritePaths) {
      lines.push(`(allow file-write* (subpath "${escapeSchemeString(p)}"))`);
    }
  }

  // Allow writes to ephemeral process IO devices
  lines.push(
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/zero") (literal "/dev/urandom") (literal "/dev/dtracehelper"))'
  );

  return lines.join("\n") + "\n";
}
