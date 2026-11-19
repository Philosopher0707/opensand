import * as os from "node:os";
import * as path from "node:path";

/**
 * targets.json v1 types (docs/design/phase8-reach.md §3).
 *
 * The file is owner-edited and validated strictly on load. An invalid file makes
 * every target operation refuse and names the bad key; there is no default and
 * no fallback, for the same reason mesh/routes.json does not fall back.
 * No password, key path or token field exists — unknown keys are refused.
 */

export type TargetSandbox = "bwrap" | "none";
export type TargetRuntime = "docker" | "podman";
export type TargetNetwork = "none" | "bridge";

export interface SshTargetConfig {
  kind: "ssh";
  host: string;
  /** Absolute path on the host; the mission directory lives under it. */
  root: string;
  sshArgs?: string[];
  sandbox?: TargetSandbox;
}

export interface ContainerTargetConfig {
  kind: "container";
  runtime?: TargetRuntime;
  image: string;
  network?: TargetNetwork;
  memory?: string;
  cpus?: number;
  /** The container root is fixed at /workspace (design §3); not configurable. */
}

export type TargetConfig = SshTargetConfig | ContainerTargetConfig;

export interface TargetsFile {
  version: 1;
  targets: Record<string, TargetConfig>;
}

export class TargetConfigError extends Error {
  /** The targets.json key that made the file invalid, when it is one key's fault. */
  public readonly key?: string;

  constructor(message: string, key?: string) {
    super(message);
    this.name = "TargetConfigError";
    this.key = key;
  }
}

/** `$OPENSAND_HOME` when set, else `~/.opensand` (same rule as mesh/routes.json). */
export function opensandHome(): string {
  return process.env.OPENSAND_HOME || path.join(os.homedir(), ".opensand");
}

export function targetsFilePath(home?: string): string {
  return path.join(home ?? opensandHome(), "targets.json");
}

