import * as path from "node:path";

/**
 * A write or network access the sandbox refused. Neither sandbox-exec (macOS)
 * nor bubblewrap (Linux) prints anything for a refused access; the program
 * sees EPERM (macOS) or EROFS (bubblewrap's read-only binds), or a failed DNS
 * lookup, and reports it on stderr in its own format, so this is parsed from
 * the formats real tools use.
 */
export interface SandboxDenial {
  kind: "file" | "network";
  /** Absolute path, resolved against the command's cwd. Absent for network. */
  path?: string;
  /** The stderr line the denial was read from. */
  detail: string;
}

const MAX_DENIALS = 20;

// Python: PermissionError: [Errno 1] Operation not permitted: '/x/y' (or [Errno 30] Read-only file system)
const PYTHON_EPERM = /(?:Operation not permitted|Read-only file system): '([^']+)'/;
// Node: EPERM: operation not permitted, open '/x/y' (or EROFS: read-only file system)
const NODE_EPERM = /(?:EPERM: operation not permitted|EROFS: read-only file system), \w+ '([^']+)'/;
// bash, coreutils, git: "touch: ../x: Operation not permitted", "fatal: cannot mkdir x: Read-only file system"
const POSIX_EPERM = /(?:^|: )(?:cannot \w+ )?([^:]+): (?:Operation not permitted|Read-only file system)\s*$/;
const NETWORK_FAILURE =
  /Could not resolve host|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|nodename nor servname provided|Temporary failure in name resolution|Network is unreachable/i;

export function parseSandboxDenials(
  stderr: string,
  options: { cwd: string; networkDenied: boolean }
): SandboxDenial[] {
  const denials: SandboxDenial[] = [];
  const seen = new Set<string>();

  for (const rawLine of stderr.split("\n")) {
    if (denials.length >= MAX_DENIALS) break;
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(PYTHON_EPERM) ?? line.match(NODE_EPERM) ?? line.match(POSIX_EPERM);
    if (match) {
      const target = path.resolve(options.cwd, match[1].trim());
      const key = `file:${target}`;
      if (!seen.has(key)) {
        seen.add(key);
        denials.push({ kind: "file", path: target, detail: line });
      }
      continue;
    }

    if (options.networkDenied && NETWORK_FAILURE.test(line) && !seen.has("network")) {
      seen.add("network");
      denials.push({ kind: "network", detail: line });
    }
  }

  return denials;
}
