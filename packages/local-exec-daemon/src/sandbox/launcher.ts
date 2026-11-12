import fs from "node:fs";

export type SandboxLauncher =
  | { kind: "sandbox-exec"; path: string }
  | { kind: "bwrap"; path: string }
  | { kind: "unavailable"; reason: string };

export function resolveSandboxLauncher(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync
): SandboxLauncher {
  if (platform === "darwin") {
    const defaultPath = "/usr/bin/sandbox-exec";
    if (exists(defaultPath)) {
      return { kind: "sandbox-exec", path: defaultPath };
    }
    return { kind: "unavailable", reason: `${defaultPath} binary not found` };
  }

  if (platform === "linux") {
    if (env.OPENSAND_BWRAP_PATH) {
      const customPath = env.OPENSAND_BWRAP_PATH;
      if (exists(customPath)) {
        return { kind: "bwrap", path: customPath };
      }
      return { kind: "unavailable", reason: `bubblewrap binary not found at ${customPath}` };
    }

    const primaryPath = "/usr/bin/bwrap";
    if (exists(primaryPath)) {
      return { kind: "bwrap", path: primaryPath };
    }

    const fallbackPath = "/bin/bwrap";
    if (exists(fallbackPath)) {
      return { kind: "bwrap", path: fallbackPath };
    }

    return { kind: "unavailable", reason: "bubblewrap binary not found (/usr/bin/bwrap, /bin/bwrap)" };
  }

  return {
    kind: "unavailable",
    reason: `sandbox containment is not supported on platform: ${platform}`,
  };
}
