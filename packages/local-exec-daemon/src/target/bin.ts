#!/usr/bin/env node
import * as path from "node:path";
import { serveTargetStdio, TargetServer, scrubServerEnv } from "./server.js";

/**
 * `opensand-target --stdio --root <absolute-path> [--sandbox bwrap|none] [--target-id <name>]`
 *
 * It prints nothing on stdout except framed responses; diagnostics go to stderr.
 * The environment is reduced to the allowlist first, so no key, token or
 * SSH_AUTH_SOCK inherited by the server can reach a child command.
 */

interface BinArgs {
  root: string;
  sandbox: "bwrap" | "none";
  targetId: string;
}

function parseArgs(argv: string[]): BinArgs {
  const args: BinArgs = { root: "", sandbox: "none", targetId: process.env.OPENSAND_TARGET_ID ?? "opensand-target" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stdio") continue;
    if (arg === "--root") {
      args.root = argv[++i] ?? "";
      continue;
    }
    if (arg === "--sandbox") {
      const value = argv[++i] ?? "";
      if (value !== "bwrap" && value !== "none") {
        throw new Error(`--sandbox must be bwrap or none, got "${value}"`);
      }
      args.sandbox = value;
      continue;
    }
    if (arg === "--target-id") {
      args.targetId = argv[++i] ?? "";
      continue;
    }
    throw new Error(`unknown argument "${arg}"`);
  }
  if (!args.root) throw new Error("--root <absolute-path> is required");
  if (!path.isAbsolute(args.root)) throw new Error(`--root must be an absolute path, got "${args.root}"`);
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  scrubServerEnv(process.env);
  const server = new TargetServer({ root: args.root, sandbox: args.sandbox, targetId: args.targetId });
  await serveTargetStdio(server, process.stdin, process.stdout);
}

main().catch((err) => {
  process.stderr.write(`opensand-target: ${(err as Error).message}\n`);
  process.exit(1);
});
