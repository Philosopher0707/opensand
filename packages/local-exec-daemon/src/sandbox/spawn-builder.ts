import fs from "node:fs";
import { resolveSandboxLauncher } from "./launcher.js";
import { buildBwrapArgs } from "./linux-bwrap.js";
import { generateMacosSandboxProfile } from "./macos-profile.js";
import { SandboxInitializationError } from "./errors.js";
import type { SandboxProfileType } from "./macos-profile.js";

export interface BuildSandboxedSpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  sandboxProfile?: SandboxProfileType;
  workspaceRoot?: string;
  homeDir?: string;
  tempDir?: string;
  allowNetwork?: boolean;
  customProfileString?: string;
  useInfoFd?: boolean; // true for command-runner batch exec, false for pty-session
  platform?: NodeJS.Platform; // defaults to process.platform
  env?: NodeJS.ProcessEnv; // defaults to process.env
  exists?: (path: string) => boolean; // defaults to fs.existsSync
}

export interface SandboxedSpawnConfig {
  command: string;
  args: string[];
  isSandboxed: boolean;
  isBwrap: boolean;
  isSandboxExec: boolean;
  mechanism?: string;
  infoFd?: number;
}

function resolveTarget(
  command: string,
  args?: string[]
): { command: string; args: string[] } {
  if (args && args.length > 0) {
    return { command, args: [...args] };
  }
  if (command.includes(" ")) {
    return { command: "/bin/bash", args: ["-c", command] };
  }
  return { command, args: [] };
}

/**
 * Build a unified sandboxed spawn configuration for both batch exec (command-runner)
 * and interactive PTY sessions (pty-session). Callers pass the resolved config
 * straight into `child_process.spawn`.
 */
export function buildSandboxedSpawn(
  options: BuildSandboxedSpawnOptions
): SandboxedSpawnConfig {
  const {
    command,
    args,
    cwd,
    sandboxProfile,
    workspaceRoot,
    homeDir,
    tempDir,
    allowNetwork,
    customProfileString,
    useInfoFd = false,
    platform = process.platform,
    env = process.env,
    exists = fs.existsSync,
  } = options;

  const { command: targetCommand, args: targetArgs } = resolveTarget(command, args);

  const sandboxRequested = Boolean(
    sandboxProfile || customProfileString || env.OPENSAND_SANDBOX === "1"
  );

  if (!sandboxRequested) {
    return {
      command: targetCommand,
      args: targetArgs,
      isSandboxed: false,
      isBwrap: false,
      isSandboxExec: false,
    };
  }

  const launcher = resolveSandboxLauncher(platform, env, exists);

  if (launcher.kind === "unavailable") {
    const mechanism =
      platform === "linux"
        ? "Linux bubblewrap"
        : platform === "darwin"
          ? "macOS sandbox-exec"
          : platform;
    throw new SandboxInitializationError(launcher.reason, {
      mechanism,
      code: "SANDBOX_UNAVAILABLE",
    });
  }

  if (launcher.kind === "sandbox-exec") {
    let profileString = customProfileString;
    if (!profileString) {
      profileString = generateMacosSandboxProfile({
        workspaceRoot: workspaceRoot ?? cwd ?? process.cwd(),
        homeDir,
        tempDir,
        profile: sandboxProfile ?? "workspace-write",
        allowNetwork,
      });
    }
    return {
      command: launcher.path,
      args: ["-p", profileString, targetCommand, ...targetArgs],
      isSandboxed: true,
      isBwrap: false,
      isSandboxExec: true,
      mechanism: "macOS sandbox-exec",
    };
  }

  // launcher.kind === "bwrap"
  if (customProfileString) {
    throw new SandboxInitializationError("customProfileString is macOS-only", {
      mechanism: "Linux bubblewrap",
    });
  }

  const bwrapArgs = buildBwrapArgs({
    workspaceRoot: workspaceRoot ?? cwd ?? process.cwd(),
    homeDir,
    tempDir,
    profile: sandboxProfile ?? "workspace-write",
    allowNetwork,
    exists,
  });

  if (useInfoFd) {
    return {
      command: launcher.path,
      args: [...bwrapArgs, "--info-fd", "3", "--", targetCommand, ...targetArgs],
      isSandboxed: true,
      isBwrap: true,
      isSandboxExec: false,
      mechanism: "Linux bubblewrap",
      infoFd: 3,
    };
  }

  return {
    command: launcher.path,
    args: [...bwrapArgs, "--", targetCommand, ...targetArgs],
    isSandboxed: true,
    isBwrap: true,
    isSandboxExec: false,
    mechanism: "Linux bubblewrap",
  };
}
