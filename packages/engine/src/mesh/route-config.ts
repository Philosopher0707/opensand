/**
 * Phase 7 mesh/routes.json loading and the stats projection the mission start
 * path reads (docs/design/phase7-mesh-tournament.md §2.2, §3.3).
 *
 * `loadRoutesConfig` reads `$OPENSAND_HOME/mesh/routes.json` (default
 * `~/.opensand/mesh/routes.json`) and validates it with the §2.2 schema. An
 * invalid file refuses tournaments and names the wrong key; a missing file is
 * refused too, because a silent fallback would route work to a model the user
 * never chose.
 *
 * `loadMeshStats` folds the `mesh.attempt.result` records of every mission log
 * under the state root into per-(role, model) stats. Stats are projections of
 * the logs (§3.3): the fold is rebuildable, only routes.json lives under mesh/.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventLogReader } from "@opensand/shared";
import { parseRoutesConfig, type RoutesConfig } from "./routes-schema.js";
import { foldMeshStats, type MeshStats, type StatsKey } from "./stats.js";

/** Thrown when routes.json is missing or invalid; the message names the file and the key. */
export class RoutesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutesConfigError";
  }
}

/** The OpenSand home directory: `$OPENSAND_HOME` when set, else `~/.opensand`. */
export function opensandHomeDir(): string {
  return process.env.OPENSAND_HOME || path.join(os.homedir(), ".opensand");
}

export function routesPath(home: string = opensandHomeDir()): string {
  return path.join(home, "mesh", "routes.json");
}

export async function loadRoutesConfig(home: string = opensandHomeDir()): Promise<RoutesConfig> {
  const file = routesPath(home);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RoutesConfigError(
        `no mesh/routes.json at ${file} (§2.2: a missing routes file refuses the tournament; it never falls back to a default ladder)`,
      );
    }
    throw new RoutesConfigError(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RoutesConfigError(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseRoutesConfig(parsed);
  } catch (err) {
    throw new RoutesConfigError(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Fold the mesh.attempt.result records of every mission log under
 * `<stateDir>/missions/` into per-(role, model) stats (§3.3: a projection of
 * the logs). A mission log that cannot be read is skipped; the tournament
 * start refuses on its own prechecks, not on unrelated logs.
 */
export async function loadMeshStats(stateDir: string): Promise<Map<StatsKey, MeshStats>> {
  const records: unknown[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(path.join(stateDir, "missions"));
  } catch {
    return new Map();
  }
  for (const entry of entries) {
    const logPath = path.join(stateDir, "missions", entry, "event-log.jsonl");
    try {
      const events = await new EventLogReader(logPath).readAll();
      for (const e of events) {
        if ((e as { kind?: unknown }).kind === "mesh.attempt.result") records.push(e);
      }
    } catch {
      continue;
    }
  }
  return foldMeshStats(records as Parameters<typeof foldMeshStats>[0]);
}
