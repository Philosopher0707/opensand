import { isToolExecutionGranted } from "./grants-store.js";
import type { CapabilityGrant } from "./grants-types.js";
import type { NewGrant } from "./grants-store.js";

const CHAINING = /[;&|`]|\$\(|\n/;

/** Binaries that must never become a blanket `<bin> *` standing grant (same set as the always_allow path in ipc-bridge). */
export const DANGEROUS_GENERIC_BINARIES: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "node", "python", "python3", "perl", "ruby",
  "sudo", "su", "rm", "mv", "chmod", "chown", "curl", "wget", "cat", "dd",
]);

/** True when a command can run more than one thing: `;`, `&`, `|`, backtick, `$(` or a newline. */
export function hasShellChaining(command: string): boolean {
  return CHAINING.test(command);
}

function standingExecGrants(grants: unknown, now: number): CapabilityGrant[] {
  if (!Array.isArray(grants)) return [];
  return grants.filter(
    (g): g is CapabilityGrant =>
      typeof g === "object" && g !== null &&
      g.tool === "exec_command" && g.lifetime === "always" && typeof g.scope === "string" &&
      (g.expiresAt === undefined || (typeof g.expiresAt === "number" && g.expiresAt > now)),
  );
}

/**
 * Is `command` standing-allowed by `grants`? The chaining guard runs first because the shared
 * scope matcher has none (`git *` would otherwise match `git status; rm -rf ~`). Only `always`
 * exec_command grants count, and the query carries the command alone, so path or domain scopes
 * cannot match. Anything missing or malformed denies.
 */
export function isStandingExecAllowed(
  grants: readonly CapabilityGrant[] | undefined,
  command: string,
  now: number = Date.now(),
): boolean {
  if (typeof command !== "string" || command.trim() === "") return false;
  if (hasShellChaining(command)) return false;
  return isToolExecutionGranted(standingExecGrants(grants, now), { tool: "exec_command", command }, now);
}

/** Legacy standing-allowlist view of the grants: `git *` becomes `git`, exact scopes stay as they are. */
export function standingExecPatterns(grants: readonly CapabilityGrant[] | undefined, now: number = Date.now()): string[] {
  return standingExecGrants(grants, now).map((g) => (g.scope.endsWith(" *") ? g.scope.slice(0, -2) : g.scope));
}

export interface SkippedLegacyPattern {
  pattern: unknown;
  reason: string;
}

/**
 * Convert legacy standing-allowlist patterns into `always` exec_command grants. A single token
 * `p` (the old matcher read it as "p or p ...") becomes `p *`; a trailing `*` keeps its prefix;
 * any other pattern stays exact. Empty, wildcard-only, chaining, non-string and dangerous
 * interpreter patterns are skipped, never guessed at.
 */
export function legacyPatternsToGrants(patterns: readonly unknown[]): { grants: NewGrant[]; skipped: SkippedLegacyPattern[] } {
  const grants: NewGrant[] = [];
  const skipped: SkippedLegacyPattern[] = [];
  if (!Array.isArray(patterns)) return { grants, skipped };
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (typeof pattern !== "string") {
      skipped.push({ pattern, reason: "not a string" });
      continue;
    }
    const p = pattern.trim();
    if (p === "") {
      skipped.push({ pattern, reason: "empty" });
      continue;
    }
    if (hasShellChaining(p)) {
      skipped.push({ pattern, reason: "contains shell chaining" });
      continue;
    }
    const prefixStyle = p.endsWith("*");
    const base = prefixStyle ? p.slice(0, -1).trim() : p;
    if (base === "") {
      skipped.push({ pattern, reason: "wildcard only" });
      continue;
    }
    const tokens = base.split(/\s+/);
    if ((prefixStyle || tokens.length === 1) && DANGEROUS_GENERIC_BINARIES.has(tokens[0])) {
      skipped.push({ pattern, reason: `dangerous interpreter '${tokens[0]}' is exact-only` });
      continue;
    }
    const scope = prefixStyle || tokens.length === 1 ? `${base} *` : p;
    if (seen.has(scope)) continue;
    seen.add(scope);
    grants.push({ tool: "exec_command", scope, lifetime: "always" });
  }
  return { grants, skipped };
}
