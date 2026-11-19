/**
 * `opensand mission` verbs (docs/design/phase7-mesh-tournament.md §10 S5):
 *   opensand mission tournament <id> --attempts 3 [--check <cmd>] [...]
 *   opensand mission reconcile <id>
 *   opensand mission attempt restore <n> [id]
 *
 * The verbs drive the engine package's mesh surface. The engine is loaded from
 * the monorepo layout the CLI ships in (`<repo>/packages/engine/dist`), the
 * same layout `scripts/package-cli.sh` resolves `cli-app.js` from; there is no
 * package dependency on the engine, so the workspace lockfile stays untouched.
 */

import { spawnSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { EventLogReader } from "@opensand/shared";
import { defaultOpenRouterCatalog, type OpenRouterModel } from "@opensand/coordinator";

export const MISSION_USAGE = `Usage:
  opensand mission tournament <id> --attempts 3 --check <command> [--role coder] [--concurrency N] [--task <text>] [--workspace <dir>] [--budget <usd>] [--endpoint <url>] [--api-key <key>]
  opensand mission reconcile <id> [--workspace <dir>] [--state-dir <dir>]
  opensand mission attempt restore <n> [id] [--workspace <dir>] [--state-dir <dir>]

Routes live at \$OPENSAND_HOME/mesh/routes.json (default ~/.opensand/mesh/routes.json);
a missing or invalid routes file refuses the tournament (no default ladder).`;

/** Minimal typing over the engine module the bridge loads; the engine owns the real types. */
interface EngineBridge {
  startTournament(options: Record<string, unknown>): Promise<{
    status: string;
    winner: number | null;
    keptBranch: string | null;
    keptPath: string | null;
    totalCostUsd: number;
    startModel: string;
    startReason: string;
  }>;
  reconcileTournament(options: { missionId: string; repoRoot: string; stateDir: string }): Promise<Array<{ attempt: number; action: string }>>;
  restoreSnapshot(workspaceRoot: string, missionId: string, snapshotRef: string): Promise<{ restoredSnapshot: string; restoredFilesCount: number }>;
  loadRoutesConfig(home?: string): Promise<unknown>;
  loadMeshStats(stateDir: string): Promise<Map<string, unknown>>;
  opensandHomeDir(): string;
  openAiCompatProvider(baseUrl: string, opts?: { apiKey?: string }): unknown;
  buildTournamentSection(events: unknown[]): Record<string, unknown> | undefined;
  renderTournamentSection(section: Record<string, unknown>): string[];
}

let engineCache: EngineBridge | undefined;

/**
 * Load the engine's compiled entry from the monorepo the CLI runs in: walk up
 * from this module's dist location to the root holding packages/engine.
 */
async function loadEngine(): Promise<EngineBridge> {
  if (engineCache) return engineCache;
  let probe = path.dirname(new URL(import.meta.url).pathname); // packages/cli/dist/src
  let root: string | null = null;
  for (let i = 0; i < 8; i++) {
    if (fsSync.existsSync(path.join(probe, "packages", "engine", "package.json"))) {
      root = probe;
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (!root) {
    throw new Error(
      "opensand mission: cannot find packages/engine next to this CLI — run `pnpm run build` at the repo root",
    );
  }
  const entry = path.join(root, "packages", "engine", "dist", "src", "index.js");
  if (!fsSync.existsSync(entry)) {
    throw new Error(`opensand mission: engine build missing at ${entry} — run \`pnpm run build\` at the repo root`);
  }
  engineCache = (await import(pathToFileURL(entry).href)) as unknown as EngineBridge;
  return engineCache;
}

interface Parsed {
  positional: string[];
  flags: Record<string, string>;
}

function parseFlags(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const valued = new Set([
    "--attempts", "--concurrency", "--role", "--task", "--workspace", "--state-dir",
    "--budget", "--endpoint", "--api-key", "--check", "--model",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (valued.has(arg) && i + 1 < argv.length) {
      flags[arg.slice(2)] = argv[++i]!;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
    // Unknown flags are ignored; the mission verbs accept only the ones above.
  }
  return { positional, flags };
}

interface MissionStartInfo {
  workspaceRoot?: string;
  title?: string;
}

async function missionStartInfo(stateDir: string, missionId: string): Promise<MissionStartInfo> {
  const logPath = path.join(stateDir, "missions", missionId, "event-log.jsonl");
  try {
    const events = await new EventLogReader(logPath).readAll();
    const started = events.find((e) => e.kind === "mission.started") as
      | { data?: { workspaceRoot?: string; title?: string } }
      | undefined;
    return { workspaceRoot: started?.data?.workspaceRoot, title: started?.data?.title };
  } catch {
    return {};
  }
}

function resolveWorkspace(flags: Record<string, string>, info: MissionStartInfo): string {
  return path.resolve(flags.workspace || info.workspaceRoot || process.cwd());
}

function resolveStateDir(flags: Record<string, string>): string {
  return path.resolve(flags["state-dir"] || process.env.OPENSAND_HOME || path.join(os.homedir(), ".opensand"));
}

/** ModelCatalog entries for `openrouter:<id>` ladder rungs, priced from the OpenRouter catalog. */
async function catalogForLadder(
  ladder: readonly string[],
  opts: { endpoint?: string; apiKey?: string },
): Promise<Record<string, { priceInUsdPerMTok: number; priceOutUsdPerMTok: number }>> {
  const openrouterIds = new Set(
    ladder.filter((m) => m.startsWith("openrouter:")).map((m) => m.slice("openrouter:".length)),
  );
  const catalog: Record<string, { priceInUsdPerMTok: number; priceOutUsdPerMTok: number }> = {};
  if (openrouterIds.size === 0) return catalog;
  const models: OpenRouterModel[] = await defaultOpenRouterCatalog.fetchModels(opts.endpoint, opts.apiKey);
  for (const id of openrouterIds) {
    const entry = models.find((m) => m.id === id || m.name === id);
    const prompt = Number(entry?.pricing?.prompt);
    const completion = Number(entry?.pricing?.completion);
    if (Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0) {
      // OpenRouter prices are USD per token; the engine's catalog is per million.
      catalog[`openrouter:${id}`] = {
        priceInUsdPerMTok: prompt * 1_000_000,
        priceOutUsdPerMTok: completion * 1_000_000,
      };
    }
    // A rung with no catalog price stays out; startTournament refuses and names it (§9 row 10).
  }
  return catalog;
}

async function runTournament(rest: string[], flags: Record<string, string>): Promise<void> {
  const missionId = rest[0];
  if (!missionId) {
    console.error(MISSION_USAGE);
    process.exit(2);
  }
  const engine = await loadEngine();
  const stateDir = resolveStateDir(flags);
  const home = process.env.OPENSAND_HOME ? path.resolve(process.env.OPENSAND_HOME) : stateDir;
  const info = await missionStartInfo(stateDir, missionId);
  const repoRoot = resolveWorkspace(flags, info);
  const routes = await engine.loadRoutesConfig(home);
  const role = flags.role || "coder";
  const roleRouting = (routes as { roles: Record<string, { ladder: string[] }> }).roles[role];
  if (!roleRouting) {
    throw new Error(`opensand mission: no ladder for role ${role} in mesh/routes.json`);
  }
  const catalog = await catalogForLadder(roleRouting.ladder, {
    endpoint: flags.endpoint || process.env.OPENSAND_ENDPOINT || process.env.OPENAI_BASE_URL,
    apiKey: flags["api-key"] || process.env.OPENSAND_API_KEY || process.env.OPENAI_API_KEY,
  });
  const stats = await engine.loadMeshStats(stateDir);
  const endpoint = flags.endpoint || process.env.OPENSAND_ENDPOINT || process.env.OPENAI_BASE_URL;
  if (!endpoint) throw new Error("opensand mission: no endpoint; pass --endpoint or set OPENSAND_ENDPOINT");
  const run = await engine.startTournament({
    missionId,
    repoRoot,
    stateDir,
    task: flags.task || info.title || "",
    role,
    routes,
    stats,
    catalog,
    checkCommand: flags.check || "",
    attempts: flags.attempts ? parseInt(flags.attempts, 10) : undefined,
    concurrency: flags.concurrency ? parseInt(flags.concurrency, 10) : undefined,
    missionBudgetUsd: flags.budget ? parseFloat(flags.budget) : undefined,
    provider: engine.openAiCompatProvider(endpoint, {
      apiKey: flags["api-key"] || process.env.OPENSAND_API_KEY || process.env.OPENAI_API_KEY,
    }),
  });
  console.log(
    `Tournament ${run.status} · winner ${run.winner ?? "none"} · kept ${run.keptBranch ?? "—"}` +
      ` · $${run.totalCostUsd.toFixed(4)} · start ${run.startModel} (${run.startReason})`,
  );
  // The receipt section, projected from the log this run appended to (§3.4).
  const logPath = path.join(stateDir, "missions", missionId, "event-log.jsonl");
  const events = await new EventLogReader(logPath).readAll();
  const section = engine.buildTournamentSection(events as unknown[]);
  if (section) {
    for (const line of engine.renderTournamentSection(section)) console.log(line);
  }
}

async function runReconcile(rest: string[], flags: Record<string, string>): Promise<void> {
  const missionId = rest[0];
  if (!missionId) {
    console.error(MISSION_USAGE);
    process.exit(2);
  }
  const engine = await loadEngine();
  const stateDir = resolveStateDir(flags);
  const info = await missionStartInfo(stateDir, missionId);
  const report = await engine.reconcileTournament({
    missionId,
    repoRoot: resolveWorkspace(flags, info),
    stateDir,
  });
  if (report.length === 0) {
    console.log(`Reconcile ${missionId}: nothing to do.`);
    return;
  }
  console.log(`Reconcile ${missionId}:`);
  for (const r of report) console.log(`  attempt ${r.attempt}: ${r.action}`);
}

/** The most recently touched mission directory, for `attempt restore <n>` without an id. */
async function latestMissionId(stateDir: string): Promise<string | null> {
  const missionsDir = path.join(stateDir, "missions");
  let entries: fsSync.Dirent[] = [];
  try {
    entries = fsSync.readdirSync(missionsDir, { withFileTypes: true }) as fsSync.Dirent[];
  } catch {
    return null;
  }
  let best: { id: string; mtime: number } | null = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const stat = await fs.stat(path.join(missionsDir, e.name, "event-log.jsonl")).catch(() => null);
    if (!stat) continue;
    if (!best || stat.mtimeMs > best.mtime) best = { id: e.name, mtime: stat.mtimeMs };
  }
  return best?.id ?? null;
}

/** The kept attempt has a branch, losers have snapshot refs; resolve either. */
function resolveAttemptRef(repoRoot: string, missionId: string, n: string): string {
  const snapshotRef = `refs/opensand/missions/${missionId}/attempts/${n}`;
  const keepBranch = `opensand/${missionId}/${n}`;
  const check = (ref: string): boolean =>
    spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repoRoot,
    }).status === 0;
  if (check(snapshotRef)) return snapshotRef;
  if (check(keepBranch)) {
    // restoreSnapshot accepts a raw commit sha for the target tree's commit.
    return spawnSync("git", ["rev-parse", keepBranch], { cwd: repoRoot }).stdout.toString().trim();
  }
  throw new Error(
    `opensand mission: attempt ${n} of ${missionId} has neither a snapshot ref nor a kept branch in ${repoRoot}`,
  );
}

async function runAttemptRestore(rest: string[], flags: Record<string, string>): Promise<void> {
  const n = rest[0];
  if (!n || !/^\d+$/.test(n)) {
    console.error(MISSION_USAGE);
    process.exit(2);
  }
  const missionId = rest[1] || (await latestMissionId(resolveStateDir(flags)));
  if (!missionId) throw new Error("opensand mission: no mission id given and no missions in the state dir");
  const engine = await loadEngine();
  const stateDir = resolveStateDir(flags);
  const info = await missionStartInfo(stateDir, missionId);
  const workspaceRoot = resolveWorkspace(flags, info);
  const ref = resolveAttemptRef(workspaceRoot, missionId, n);
  const summary = await engine.restoreSnapshot(workspaceRoot, missionId, ref);
  console.log(
    `Restored attempt ${n} of ${missionId} into ${workspaceRoot} (snapshot ${summary.restoredSnapshot}, ${summary.restoredFilesCount} files).`,
  );
}

export async function runMissionCommand(argv: string[]): Promise<void> {
  const sub = argv[1];
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(MISSION_USAGE);
    return;
  }
  const { positional, flags } = parseFlags(argv.slice(2));
  if (sub === "tournament") {
    await runTournament(positional, flags);
  } else if (sub === "reconcile") {
    await runReconcile(positional, flags);
  } else if (sub === "attempt") {
    if (positional[0] !== "restore") {
      console.error(MISSION_USAGE);
      process.exit(2);
    }
    await runAttemptRestore(positional.slice(1), flags);
  } else {
    console.error(`opensand mission: unknown verb ${sub}\n${MISSION_USAGE}`);
    process.exit(2);
  }
}
