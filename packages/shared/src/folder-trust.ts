import { isToolExecutionGranted } from "./grants-store.js";
import type { CapabilityGrant } from "./grants-types.js";
import type { TrustLevel } from "./folder-trust-types.js";

export type SandboxProfileName = "read-only" | "workspace-write" | "full";

/** The return type excludes "full": trust alone never yields an unsandboxed profile. */
export function profileForTrust(level: TrustLevel): "read-only" | "workspace-write" {
  return level === "trusted" ? "workspace-write" : "read-only";
}

export function resolveSandboxProfile(input: {
  level: TrustLevel;
  requested: SandboxProfileName | undefined;
  grants: readonly CapabilityGrant[];
  folder: string;
}): SandboxProfileName {
  if (
    input.requested === "full" &&
    input.level === "trusted" &&
    isToolExecutionGranted(input.grants, { tool: "sandbox.full", path: input.folder })
  ) {
    return "full";
  }
  return profileForTrust(input.level);
}
