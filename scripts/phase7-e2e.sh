#!/usr/bin/env bash
# Phase 7 S5 end-to-end check (docs/design/phase7-mesh-tournament.md §10 S5).
#
# The phase's two done-when items, written as one command:
#  1. writes a mesh/routes.json and a stats fixture into a temp OPENSAND_HOME;
#  2. runs a 3-attempt tournament against the local HTTP stub;
#  3. asserts `git worktree list` has two entries and the attempts root is empty;
#  4. asserts the receipt's Tournament rows match the log records one-to-one;
#  5. appends a stats fixture that changes the ladder's start, starts a new
#     mission, and asserts that its mesh.route.selected names the new start.
# It then exercises the CLI verbs: `opensand mission reconcile` and
# `opensand mission attempt restore`.
#
# The tournament driver is a small node script over the engine's compiled
# surface (the same layout scripts/package-cli.sh relies on), so no test
# framework runs here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> building the engine and CLI packages"
pnpm --filter @opensand/shared build >/dev/null
pnpm --filter @opensand/engine build >/dev/null
pnpm --filter @opensand/cli build >/dev/null

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/opensand-phase7-e2e.XXXXXX")"
OPENSAND_HOME="$STAGE/home"
mkdir -p "$OPENSAND_HOME/mesh"

# Ladder per §2.2, cheapest first: a local rung, then the deepseek cloud rung.
cat > "$OPENSAND_HOME/mesh/routes.json" <<'EOF'
{
  "version": 1,
  "roles": {
    "coder": {
      "ladder": ["stub:a", "openrouter:deepseek/deepseek-v4.1-flash"],
      "minSamples": 5,
      "minPassRate": 0.5
    }
  }
}
EOF

cleanup() {
  git worktree prune >/dev/null 2>&1 || true
  [[ -n "${REPO_PATH:-}" && -d "$REPO_PATH" ]] && rm -rf "$REPO_PATH"
  rm -rf "$STAGE"
}
trap cleanup EXIT

cat > "$STAGE/driver.mjs" <<'DRIVER'
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const [root, home] = process.argv.slice(2);
const execGit = promisify(execFile);
const git = async (args, cwd) => (await execGit("git", args, { cwd })).stdout;

const engine = await import(pathToFileURL(path.join(root, "packages/engine/dist/src/index.js")).href);
const shared = await import(pathToFileURL(path.join(root, "packages/shared/dist/src/index.js")).href);
const { StubProvider, chatResponse, writesContent } = await import(
  pathToFileURL(path.join(root, "packages/engine/dist/test/fixtures/stub-provider.js")).href
);

const DEEPSEEK = "openrouter:deepseek/deepseek-v4.1-flash";
const CHECK = 'test "$(cat README.md)" != "wrong"';

function assert(cond, message) {
  if (!cond) throw new Error(`E2E FAIL: ${message}`);
  console.log(`    ok: ${message}`);
}

async function readEvents(stateDir, missionId) {
  return new shared.EventLogReader(path.join(stateDir, "missions", missionId, "event-log.jsonl")).readAll();
}

async function seedMission(stateDir, missionId, repoRoot) {
  const dir = path.join(stateDir, "missions", missionId);
  await fs.mkdir(dir, { recursive: true });
  const writer = new shared.EventLogWriter(dir, { sessionId: missionId });
  await writer.append({
    sessionId: missionId,
    node: "plan",
    kind: "mission.started",
    data: { missionId, title: "make the check pass", workspaceRoot: repoRoot, budgetUsd: 5 },
  });
}

async function appendStatsFixture(stateDir, role, model, count) {
  // The stats fixture (§3.3): mesh.attempt.result records in a mission log of
  // their own, so the next tournament's fold sees a qualifying record.
  const dir = path.join(stateDir, "missions", "m-stats-fixture");
  await fs.mkdir(dir, { recursive: true });
  const writer = new shared.EventLogWriter(dir, { sessionId: "m-stats-fixture" });
  for (let i = 0; i < count; i++) {
    await writer.append({
      sessionId: "m-stats-fixture",
      node: "tournament",
      kind: "mesh.attempt.result",
      data: { role, model, outcome: "passed", costUsd: 0.02 },
    });
  }
}

// ---- repo ----
const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "phase7-e2e-repo-"));
await git(["init", "-b", "main"], repoRoot);
await git(["config", "user.email", "e2e@opensand.local"], repoRoot);
await git(["config", "user.name", "OpenSand E2E"], repoRoot);
await fs.writeFile(path.join(repoRoot, "README.md"), "base\n");
await git(["add", "-A"], repoRoot);
await git(["commit", "-m", "base"], repoRoot);

// ---- stub provider, scripted for both missions ----
const stub = new StubProvider({
  "stub:a": [
    // mission A attempt 1, rung 0: wrong content -> check fails -> escalate
    chatResponse(writesContent({ "README.md": "wrong\n" }), { promptTokens: 100, completionTokens: 200 }),
    // mission A attempt 3, rung 0: 429 twice, then a larger good change
    { status: 429, body: { error: "rate limited" } },
    { status: 429, body: { error: "rate limited" } },
    chatResponse(writesContent({ "README.md": "good\n", "extra.txt": "x\n".repeat(60) }), {
      promptTokens: 5000,
      completionTokens: 5000,
    }),
    // mission B runs entirely at rung 1, so rung 0 is never called again.
  ],
  [DEEPSEEK]: [
    // mission A attempt 1, rung 1: the good change -> attempt 1 passes
    chatResponse(writesContent({ "README.md": "good\n" }), { promptTokens: 100, completionTokens: 200 }),
    // mission B attempt 1, rung 1: good change -> kept
    chatResponse(writesContent({ "README.md": "good\n" }), { promptTokens: 100, completionTokens: 200 }),
  ],
});
const baseUrl = await stub.start();

const stateDir = home;
const catalog = {
  "stub:a": { family: "local", priceInUsdPerMTok: 10, priceOutUsdPerMTok: 50 },
  [DEEPSEEK]: { family: "deepseek", priceInUsdPerMTok: 10, priceOutUsdPerMTok: 50 },
};

try {
  // ---- (2) the 3-attempt tournament against the stub ----
  await seedMission(stateDir, "m-a", repoRoot);
  const routes = await engine.loadRoutesConfig(home);
  assert(routes.roles.coder.ladder[1] === DEEPSEEK, "routes.json loads from OPENSAND_HOME with the deepseek rung");

  const runA = await engine.startTournament({
    missionId: "m-a",
    repoRoot,
    stateDir,
    task: "make the check pass",
    role: "coder",
    routes,
    stats: await engine.loadMeshStats(stateDir),
    catalog,
    checkCommand: CHECK,
    attempts: 3,
    concurrency: 1,
    provider: engine.openAiCompatProvider(baseUrl),
    limits: { infraBackoffMs: [5, 5, 5] },
  });
  assert(runA.status === "kept", "mission A keeps a winner");
  assert(runA.winner === 1, `mission A's winner is attempt 1 (got ${runA.winner})`);
  assert(runA.attempts.length === 3, "mission A ran 3 attempts");

  // ---- (3) worktree list: main + the kept one; attempts root empty ----
  const wts = (await git(["worktree", "list", "--porcelain"], repoRoot))
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
  assert(wts.length === 2, `git worktree list has two entries (got ${wts.length}: ${wts.join(", ")})`);
  const attemptsRoot = path.join(stateDir, "missions", "m-a", "attempts");
  const leftover = await fs.readdir(attemptsRoot).then((e) => e.length).catch(() => 0);
  assert(leftover === 0, `the attempts root is empty apart from the kept attempt (got ${leftover} entries)`);

  // ---- (4) receipt Tournament rows match the log records one-to-one ----
  const eventsA = await readEvents(stateDir, "m-a");
  const resultsA = eventsA.filter((e) => e.kind === "mesh.attempt.result");
  const sectionA = engine.buildTournamentSection(eventsA);
  assert(sectionA, "mission A's log projects a Tournament section");
  assert(
    sectionA.rows.length === resultsA.length,
    `receipt rows match mesh.attempt.result records one-to-one (${sectionA.rows.length} rows, ${resultsA.length} records)`,
  );
  for (let i = 0; i < resultsA.length; i++) {
    const data = resultsA[i].data;
    assert(
      sectionA.rows[i].attempt === resultsA[i].attempt &&
        sectionA.rows[i].outcome === data.outcome &&
        sectionA.rows[i].model === data.model &&
        sectionA.rows[i].diffLines === data.diffLines &&
        sectionA.rows[i].costUsd === data.costUsd,
      `receipt row ${i} mirrors its log record (attempt ${resultsA[i].attempt})`,
    );
  }
  const linesA = engine.renderTournamentSection(sectionA);
  assert(linesA.some((l) => l.startsWith("Tournament  3 attempts, 1 concurrent")), "the receipt header line is rendered");
  assert(linesA.some((l) => l.includes("← kept (branch opensand/m-a/1)")), "the kept row is marked");
  assert(linesA.some((l) => l.includes("Judge: deterministic (2 passed)")), "the judge line names the tie-break");
  assert(
    linesA.some((l) => l.includes("Routing: coder start stub:a (no-qualifying-record); escalated to rung 1")),
    "the routing line names the start and the escalation",
  );
  const routeA = eventsA.find((e) => e.kind === "mesh.route.selected");
  assert(routeA && routeA.data.rung === 0 && routeA.data.model === "stub:a", "mission A's mesh.route.selected names rung 0");

  // ---- (5) the stats fixture changes the ladder's start ----
  await appendStatsFixture(stateDir, "coder", DEEPSEEK, 5);
  await seedMission(stateDir, "m-b", repoRoot);
  const runB = await engine.startTournament({
    missionId: "m-b",
    repoRoot,
    stateDir,
    task: "make the check pass",
    role: "coder",
    routes: await engine.loadRoutesConfig(home),
    stats: await engine.loadMeshStats(stateDir),
    catalog,
    checkCommand: CHECK,
    attempts: 1,
    concurrency: 1,
    provider: engine.openAiCompatProvider(baseUrl),
    limits: { infraBackoffMs: [5, 5, 5] },
  });
  assert(runB.status === "kept", "mission B keeps a winner");
  assert(runB.startModel === DEEPSEEK && runB.startRung === 1, "mission B starts at the deepseek rung");
  const eventsB = await readEvents(stateDir, "m-b");
  const routeB = eventsB.find((e) => e.kind === "mesh.route.selected");
  assert(
    routeB && routeB.data.model === DEEPSEEK && routeB.data.rung === 1 && routeB.data.reason === "qualifying-record",
    "mission B's mesh.route.selected names the new start (deepseek, rung 1, qualifying-record)",
  );

  // ---- the CLI verbs over the same state ----
  console.log("    ok: engine-side checks all passed; CLI verbs run next");
  // The repo (and state) stay for the CLI verbs the script runs next.
  console.log(`REPO=${repoRoot}`);
} finally {
  await stub.close();
}
DRIVER

echo "==> [e2e] engine-side checks (routes, tournament, worktrees, receipt, routing)"
DRIVER_OUT=$(node "$STAGE/driver.mjs" "$ROOT" "$OPENSAND_HOME")
echo "$DRIVER_OUT"

# The driver keeps the repo it ran against (it does not clean up on success);
# the CLI verbs run against the same state.
REPO="$(printf '%s\n' "$DRIVER_OUT" | sed -n 's/^REPO=//p')"
if [[ -z "$REPO" || ! -d "$REPO" ]]; then
  echo "FAIL: driver did not report its repo root" >&2
  exit 1
fi
REPO_PATH="$REPO"

CLI="$ROOT/packages/cli/dist/src/bin.js"
if [[ ! -f "$CLI" ]]; then
  echo "FAIL: CLI build missing at $CLI" >&2
  exit 1
fi

echo "==> [e2e] CLI verb: opensand mission reconcile m-a"
RECONCILE_OUT=$(node "$CLI" mission reconcile m-a --state-dir "$OPENSAND_HOME" --workspace "$REPO")
echo "$RECONCILE_OUT" | sed 's/^/    /'
echo "$RECONCILE_OUT" | grep -q "nothing to do" || {
  echo "FAIL: reconcile on a cleanly finished tournament should be a no-op" >&2
  exit 1
}

echo "==> [e2e] CLI verb: opensand mission attempt restore 2 m-a (the loser's snapshot)"
RESTORE_OUT=$(node "$CLI" mission attempt restore 2 m-a --state-dir "$OPENSAND_HOME" --workspace "$REPO")
echo "$RESTORE_OUT" | sed 's/^/    /'
test -f "$REPO/extra.txt" || {
  echo "FAIL: attempt 2's snapshot restore did not bring back extra.txt" >&2
  exit 1
}

echo "==> [e2e] CLI verb: opensand mission attempt restore 1 m-a (the kept attempt)"
RESTORE_OUT=$(node "$CLI" mission attempt restore 1 m-a --state-dir "$OPENSAND_HOME" --workspace "$REPO")
echo "$RESTORE_OUT" | sed 's/^/    /'
grep -q "^good$" "$REPO/README.md" || {
  echo "FAIL: attempt 1's (kept) snapshot restore did not set the kept README" >&2
  exit 1
}
# Note: restore deletes only files covered by later mission snapshots (the
# engine's Phase 2/3 rule); an untracked stray like extra.txt stays on disk.

echo "==> phase7-e2e: all five checks passed"
