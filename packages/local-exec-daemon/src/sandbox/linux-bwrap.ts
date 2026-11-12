import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DENIED_SECRET_REL_PATHS } from "./constants.js";
import { SandboxProfileType } from "./macos-profile.js";

export interface BuildBwrapArgsOptions {
  workspaceRoot: string;
  homeDir?: string;
  tempDir?: string;
  profile?: SandboxProfileType;
  allowNetwork?: boolean;
  exists?: (targetPath: string) => boolean;
  isDir?: (targetPath: string) => boolean;
}

export function buildBwrapArgs(options: BuildBwrapArgsOptions): string[] {
  const {
    workspaceRoot,
    homeDir = os.homedir(),
    tempDir,
    profile = "workspace-write",
    allowNetwork = false,
    exists = fs.existsSync,
    isDir,
  } = options;

  const args: string[] = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
  ];

  if (!allowNetwork) {
    args.push("--unshare-net");
  }

  if (profile === "full") {
    args.push("--bind", "/", "/");
    args.push("--dev", "/dev");
    args.push("--proc", "/proc");
  } else if (profile === "read-only") {
    args.push("--ro-bind", "/", "/");
    args.push("--dev", "/dev");
    args.push("--proc", "/proc");
  } else {
    // workspace-write
    args.push("--ro-bind", "/", "/");
    args.push("--dev", "/dev");
    args.push("--proc", "/proc");
    args.push("--tmpfs", "/tmp");
    if (tempDir) {
      args.push("--bind", tempDir, tempDir);
    }
    args.push("--bind", workspaceRoot, workspaceRoot);

    const cachePaths = [
      path.join(homeDir, ".npm"),
      path.join(homeDir, ".cache"),
      path.join(homeDir, ".pnpm-store"),
    ];
    for (const c of cachePaths) {
      if (exists(c)) {
        args.push("--bind", c, c);
      }
    }
  }

  // Secret overlays last so nothing re-exposes them
  const KNOWN_SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".config", ".opensand/vault"]);

  for (const relPath of DENIED_SECRET_REL_PATHS) {
    const target = path.join(homeDir, relPath);
    if (!exists(target)) {
      continue;
    }

    let isDirectory = false;
    if (isDir) {
      isDirectory = isDir(target);
    } else {
      try {
        isDirectory = fs.statSync(target).isDirectory();
      } catch {
        isDirectory = KNOWN_SECRET_DIRS.has(relPath);
      }
    }

    if (isDirectory) {
      args.push("--tmpfs", target);
    } else {
      args.push("--ro-bind", "/dev/null", target);
    }
  }

  return args;
}
