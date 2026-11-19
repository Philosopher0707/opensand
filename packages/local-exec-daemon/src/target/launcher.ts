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
