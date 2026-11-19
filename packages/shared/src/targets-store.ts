import * as fs from "node:fs/promises";
import * as path from "node:path";
import { targetsFilePath, type TargetConfig, type TargetNetwork, type TargetRuntime, type TargetSandbox, type TargetsFile, TargetConfigError } from "./target-types.js";

/**
 * Strict targets.json v1 loader (docs/design/phase8-reach.md §3).
 * Read-only by design: the file is owner-edited and never written from here.
 * The types live in target-types.js; the loader lives here.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TargetConfigError(`targets.json "${key}" must be a non-empty string`, key);
  }
  return value;
}

function expectEnum<T extends string>(value: unknown, key: string, allowed: readonly T[], fallback?: T): T {
  if (value === undefined) {
    if (fallback === undefined) throw new TargetConfigError(`targets.json "${key}" is required`, key);
    return fallback;
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new TargetConfigError(`targets.json "${key}" must be one of ${allowed.join(", ")}`, key);
  }
  return value as T;
}

const TARGET_KEYS = {
  ssh: new Set(["kind", "host", "root", "sshArgs", "sandbox"]),
  container: new Set(["kind", "runtime", "image", "network", "memory", "cpus"]),
} as const;

function parseTarget(name: string, value: unknown): TargetConfig {
  if (!isRecord(value)) {
    throw new TargetConfigError(`targets.json "${name}" must be an object`, name);
  }
  const kind = value.kind;
  if (kind !== "ssh" && kind !== "container") {
    throw new TargetConfigError(`targets.json "${name}".kind must be "ssh" or "container"`, `${name}.kind`);
  }
  const allowed = TARGET_KEYS[kind];
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TargetConfigError(`targets.json "${name}" has unknown key "${key}" for kind ${kind}`, `${name}.${key}`);
    }
  }
  if (kind === "ssh") {
    const host = expectString(value.host, `${name}.host`);
    const root = expectString(value.root, `${name}.root`);
    if (!path.isAbsolute(root)) {
      throw new TargetConfigError(`targets.json "${name}".root must be an absolute path`, `${name}.root`);
    }
    let sshArgs: string[] | undefined;
    if (value.sshArgs !== undefined) {
      if (!Array.isArray(value.sshArgs) || value.sshArgs.some((a) => typeof a !== "string")) {
        throw new TargetConfigError(`targets.json "${name}".sshArgs must be an array of strings`, `${name}.sshArgs`);
      }
      sshArgs = value.sshArgs as string[];
    }
    const config: TargetConfig & { kind: "ssh" } = { kind: "ssh", host, root };
    if (sshArgs !== undefined) config.sshArgs = sshArgs;
    if (value.sandbox !== undefined) config.sandbox = expectEnum<TargetSandbox>(value.sandbox, `${name}.sandbox`, ["bwrap", "none"]);
    return config;
  }
  const image = expectString(value.image, `${name}.image`);
  const container: TargetConfig & { kind: "container" } = { kind: "container", image };
  if (value.runtime !== undefined) container.runtime = expectEnum<TargetRuntime>(value.runtime, `${name}.runtime`, ["docker", "podman"]);
  if (value.network !== undefined) container.network = expectEnum<TargetNetwork>(value.network, `${name}.network`, ["none", "bridge"]);
  if (value.memory !== undefined) container.memory = expectString(value.memory, `${name}.memory`);
  if (value.cpus !== undefined) {
    if (typeof value.cpus !== "number" || !Number.isFinite(value.cpus) || value.cpus <= 0) {
      throw new TargetConfigError(`targets.json "${name}".cpus must be a positive number`, `${name}.cpus`);
    }
    container.cpus = value.cpus;
  }
  return container;
}

/** Parse and validate the full contents of a targets.json file. Throws, never defaults. */
export function parseTargetsFile(content: string): TargetsFile {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (err) {
    throw new TargetConfigError(`targets.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(value)) {
    throw new TargetConfigError("targets.json must be a JSON object");
  }
  if (value.version !== 1) {
    throw new TargetConfigError(`targets.json "version" must be 1, got ${JSON.stringify(value.version)}`, "version");
  }
  if (!isRecord(value.targets)) {
    throw new TargetConfigError('targets.json "targets" must be an object', "targets");
  }
  const targets: Record<string, TargetConfig> = {};
  for (const [name, config] of Object.entries(value.targets)) {
    if (name === "local") {
      throw new TargetConfigError(
        'targets.json must not declare "local": it is the implicit default target',
        "local",
      );
    }
    targets[name] = parseTarget(name, config);
  }
  return { version: 1, targets };
}

/** Read and validate targets.json. A missing or invalid file throws — fail closed. */
export async function loadTargetsFile(filePath?: string): Promise<TargetsFile> {
  const resolved = filePath ?? targetsFilePath();
  let content: string;
  try {
    content = await fs.readFile(resolved, "utf8");
  } catch {
    throw new TargetConfigError(`targets.json could not be read at ${resolved}; no target is trusted without it`);
  }
  return parseTargetsFile(content);
}

/** Look one target up by name. "local" is implicit and never resolves from the file. */
export function resolveTargetConfig(file: TargetsFile, name: string): TargetConfig {
  if (name === "local") {
    throw new TargetConfigError('target "local" is implicit and is not read from targets.json');
  }
  const config = file.targets[name];
  if (!config) {
    throw new TargetConfigError(
      `target "${name}" is not declared in targets.json (declared: ${Object.keys(file.targets).join(", ") || "none"})`,
      name,
    );
  }
  return config;
}
