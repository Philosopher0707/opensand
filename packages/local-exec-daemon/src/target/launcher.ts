import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type TargetClient } from "./client.js";
import { TargetErrorCodes, TargetLinkError, TargetLostError, type TargetHelloResult } from "./types.js";

/**
 * The container launcher (docs/design/phase8-reach.md §4.4, §6.1).
 *
 * The container is the boundary: only the workspace and the read-only tool
 * bundle are mounted, network off by default, no Docker socket, no
 * `--privileged`, `no-new-privileges`, pids capped. The runtime is always
 * invoked with an argument array, never a shell string.
 */

const BUNDLE_MOUNT = "/opt/opensand-target";
const WORKSPACE_MOUNT = "/workspace";
const BUNDLE_ENTRY = path.posix.join(BUNDLE_MOUNT, "dist/src/target/bin.js");

export interface ContainerTargetSpec {
  runtime: "docker" | "podman";
  image: string;
  network: "none" | "bridge";
  memory?: string;
  cpus?: number;
  /** The container name's mission part; also written to the opensand.mission label. */
  missionId: string;
  /** OPENSAND_TARGET_ID inside every exec. */
  targetId: string;
  /** Local directory of the deployed target bundle (`pnpm target:build`). */
  bundleDir: string;
  /** Local mission workspace bound at /workspace. */
  workspaceRoot: string;
}

function containerName(spec: ContainerTargetSpec): string {
  return `opensand-${spec.missionId}`;
}

function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${command} ${args[0] ?? ""} failed: ${err.message}${stderr ? `\n${stderr.trim()}` : ""}`;
        reject(err);
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

/** Preflight: the image must provide node >= 22 (design §13 P2). */
export async function containerPreflight(spec: ContainerTargetSpec): Promise<string> {
  let out: { stdout: string };
  try {
    out = await run(spec.runtime, ["run", "--rm", spec.image, "node", "--version"], 120_000);
  } catch (err) {
    throw new TargetLinkError(TargetErrorCodes.ToolchainMissing, `target-toolchain-missing: cannot run node in ${spec.image}: ${(err as Error).message}`);
  }
  const match = /v(\d+)\./.exec(out.stdout.trim());
  if (!match || Number(match[1]) < 22) {
    throw new TargetLinkError(
      TargetErrorCodes.ToolchainMissing,
      `target-toolchain-missing: ${spec.image} provides ${out.stdout.trim() || "no node"}; node >= 22 is required`,
    );
  }
  return out.stdout.trim();
}

/** The `docker run` argument array for one mission container. Exported for tests. */
export function containerRunArgs(spec: ContainerTargetSpec): string[] {
  const args = [
    "run", "-d", "--rm",
    "--name", containerName(spec),
    "--label", `opensand.mission=${spec.missionId}`,
    "--label", `opensand.target=${spec.targetId}`,
    "--network", spec.network,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "512",
  ];
  if (spec.memory) args.push("--memory", spec.memory);
  if (spec.cpus) args.push("--cpus", String(spec.cpus));
  args.push("-v", `${spec.workspaceRoot}:${WORKSPACE_MOUNT}`);
  // .git is read-only so the agent cannot install hooks or move refs (Phase 7 rule).
  const gitDir = path.join(spec.workspaceRoot, ".git");
  if (fs.existsSync(gitDir)) {
    args.push("-v", `${gitDir}:${WORKSPACE_MOUNT}/.git:ro`);
  }
  args.push(
    "-v", `${spec.bundleDir}:${BUNDLE_MOUNT}:ro`,
    "-w", WORKSPACE_MOUNT,
    spec.image,
    "sleep", "infinity",
  );
  return args;
}

/** The `docker exec -i` argument array that carries the persistent link. Exported for tests. */
export function containerExecArgs(spec: ContainerTargetSpec): string[] {
  return [
    "exec", "-i",
    "-e", `OPENSAND_TARGET_ID=${spec.targetId}`,
    containerName(spec),
    "node", BUNDLE_ENTRY,
    "--stdio", "--root", WORKSPACE_MOUNT,
    "--sandbox", "none",
  ];
}

export class ContainerTargetLauncher {
  constructor(private readonly spec: ContainerTargetSpec) {}

  async preflight(): Promise<string> {
    return containerPreflight(this.spec);
  }

  /**
   * Start the container, wait until exec works, and return the handshaken client.
   * A failed start removes the container (best effort) so nothing is left behind.
   * Each attempt gets a fresh client from `makeClient`: a rejected attempt leaves
   * a dead child behind, and a target serializes over exactly one child.
   */
  async start(makeClient: () => TargetClient): Promise<{ client: TargetClient; hello: TargetHelloResult }> {
    try {
      await run(this.spec.runtime, containerRunArgs(this.spec), 120_000);
      // docker run -d returns as soon as the container starts; the first exec
      // can still race the runtime's bookkeeping, so retry briefly and bounded.
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        const client = makeClient();
        try {
          client.start();
          const hello = await client.hello();
          return { client, hello };
        } catch (err) {
          lastError = err as Error;
          await client.close().catch(() => undefined);
          if (err instanceof TargetLinkError && err.code === TargetErrorCodes.VersionMismatch) throw err;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      throw lastError ?? new TargetLostError("target container never became reachable");
    } catch (err) {
      await this.stop().catch(() => undefined);
      throw err;
    }
  }

  /** Remove the container. With `--rm` this is also the cleanup path. */
  async stop(): Promise<void> {
    await run(this.spec.runtime, ["rm", "-f", containerName(this.spec)], 60_000).catch(() => undefined);
  }
}

/**
 * Reconcile: remove containers labelled with a mission that is not running.
 * Mirrors the Phase 7 tournament reconcile pattern; called on engine start.
 */
export async function reconcileContainers(
  runtime: "docker" | "podman",
  activeMissionIds: ReadonlySet<string>,
): Promise<string[]> {
  const out = await run(
    runtime,
    ["ps", "-a", "--filter", "label=opensand.mission", "--format", "{{.ID}} {{.Names}}"],
    60_000,
  ).catch(() => ({ stdout: "" }));
  const removed: string[] = [];
  for (const line of out.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [, name] = trimmed.split(/\s+/);
    const missionId = name?.startsWith("opensand-") ? name.slice("opensand-".length) : "";
    if (missionId && !activeMissionIds.has(missionId)) {
      await run(runtime, ["rm", "-f", name], 60_000).catch(() => undefined);
      removed.push(name);
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// The SSH launcher (docs/design/phase8-reach.md §4.3, §4.4, §6.2)
// ---------------------------------------------------------------------------

export interface SshTargetSpec {
  host: string;
  /** Absolute path on the host; mission dirs live under `<root>/missions/`. */
  root: string;
  /** Extra ssh arguments from targets.json (user's config; no passwords). */
  sshArgs?: string[];
  missionId: string;
  /** OPENSAND_TARGET_ID inside every remote exec. */
  targetId: string;
  /** Local directory of the deployed target bundle (`pnpm target:build`). */
  bundleDir: string;
  /** Local mission workspace that push mirrors to `<root>/missions/<id>`. */
  workspaceRoot: string;
  sandbox: "bwrap" | "none";
}

/**
 * The ssh argument array for one remote command: the user's sshArgs first, our
 * `BatchMode=yes` last (it wins, so a target can never sit on a password
 * prompt). Host-key checking stays whatever the user's SSH config says —
 * Phase 8 never adds `StrictHostKeyChecking=no`. Agent auth is the user's own
 * `SSH_AUTH_SOCK`, passed only to the `ssh` process, never to a remote command.
 */
export function sshCommandArgs(spec: Pick<SshTargetSpec, "host" | "sshArgs">, command: string): string[] {
  return [...(spec.sshArgs ?? []), "-o", "BatchMode=yes", spec.host, command];
}

/** §6.2's bubblewrap probe for a mission-level SSH target. */
export const BWRAP_PROBE = "bwrap --ro-bind / / --dev /dev --proc /proc --unshare-net true true";

/** The environment the ssh child gets: PATH, HOME and the agent socket only. */
export function sshChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  return env;
}

/**
 * Preflight the SSH host: node >= 22, rsync, and (for a bwrap sandbox) the
 * §6.2 probe. Refusals are `target-toolchain-missing` / `target-bwrap-missing`;
 * the local workspace is never touched by a failed preflight.
 */
export async function sshPreflight(spec: SshTargetSpec): Promise<string> {
  const { remoteExec } = await import("./sync.js");
  const opts = { host: spec.host, sshArgs: spec.sshArgs };
  let node: string;
  try {
    node = (await remoteExec("node --version", opts)).stdout.trim();
  } catch (err) {
    throw new TargetLinkError(TargetErrorCodes.ToolchainMissing, `target-toolchain-missing: cannot run node on ${spec.host}: ${(err as Error).message}`);
  }
  const match = /v(\d+)\./.exec(node);
  if (!match || Number(match[1]) < 22) {
    throw new TargetLinkError(TargetErrorCodes.ToolchainMissing, `target-toolchain-missing: ${spec.host} provides ${node || "no node"}; node >= 22 is required`);
  }
  const rsync = await remoteExec("rsync --version", opts).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
  if (rsync.exitCode !== 0) {
    throw new TargetLinkError(TargetErrorCodes.ToolchainMissing, `target-toolchain-missing: rsync is not available on ${spec.host}`);
  }
  if (spec.sandbox === "bwrap") {
    const bwrap = await remoteExec(BWRAP_PROBE, opts).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    if (bwrap.exitCode !== 0) {
      throw new TargetLinkError(TargetErrorCodes.ToolchainMissing, `target-bwrap-missing: the bwrap probe failed on ${spec.host}: ${bwrap.stderr.trim() || bwrap.stdout.trim() || "unknown error"}`);
    }
  }
  return node;
}

export class SshTargetLauncher {
  private deployedHash: string | null = null;

  constructor(private readonly spec: SshTargetSpec) {}

  async preflight(): Promise<string> {
    return sshPreflight(this.spec);
  }

  /** Deploy the bundle by content hash (§4.3); idempotent, before any push. */
  async deploy(): Promise<string> {
    const { deployBundle } = await import("./sync.js");
    this.deployedHash = await deployBundle(this.spec.bundleDir, this.spec.root, { host: this.spec.host, sshArgs: this.spec.sshArgs });
    return this.deployedHash;
  }

  /**
   * Start the one persistent `ssh ... node ... --stdio` child and return the
   * handshaken client. The mission dir is created remotely first (a failed
   * push leaves it behind by design; start is idempotent over it). Each
   * attempt gets a fresh client, as with the container launcher.
   */
  async start(makeClient: () => TargetClient): Promise<{ client: TargetClient; hello: TargetHelloResult }> {
    const hash = this.deployedHash ?? (await this.deploy());
    const { remoteExec } = await import("./sync.js");
    const missionRoot = path.posix.join(this.spec.root, "missions", this.spec.missionId);
    const bin = path.posix.join(this.spec.root, ".opensand", "target", hash, "dist", "src", "target", "bin.js");
    // shq lives with the sync layer; a root with quotes must not break the remote command.
    const { shq } = await import("./manifest.js");
    await remoteExec(`mkdir -p ${shq(missionRoot)}`, { host: this.spec.host, sshArgs: this.spec.sshArgs });
    const remoteCommand = `node ${shq(bin)} --stdio --root ${shq(missionRoot)} --sandbox ${this.spec.sandbox} --target-id ${shq(this.spec.targetId)}`;
    const args = sshCommandArgs(this.spec, remoteCommand);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const client = makeClient();
      try {
        client.start();
        const hello = await client.hello();
        return { client, hello };
      } catch (err) {
        lastError = err as Error;
        await client.close().catch(() => undefined);
        if (err instanceof TargetLinkError && err.code === TargetErrorCodes.VersionMismatch) throw err;
        if (err instanceof TargetLinkError && err.code === TargetErrorCodes.ToolchainMissing) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw lastError ?? new TargetLostError("target over ssh never became reachable");
  }

  args(command: string): string[] {
    return sshCommandArgs(this.spec, command);
  }
}
