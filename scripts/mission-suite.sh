#!/usr/bin/env bash
# The phase-3 mission suite (docs/design/phase8-reach.md §10, Phase 8 S1).
#
# Runs five fixed scripted missions against the real engine (`--stdio
# --scripted-agent`) in a temp OPENSAND_HOME and a temp git workspace per
# mission, and asserts the harness verdict — never the agent's claim.
#
#   scripts/mission-suite.sh [--target local]
#
# Exit codes: 0 when every mission passes, 1 on a failed assertion, 2 on a bad
# or unavailable target. `container` and `ssh` arrive with Phase 8 S2–S4.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="local"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --target=*)
      TARGET="${1#*=}"
      shift
      ;;
    -h|--help)
      sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "FAIL: unknown argument '$1'" >&2
      echo "Usage: scripts/mission-suite.sh [--target local]" >&2
      exit 2
      ;;
  esac
done

case "$TARGET" in
  local) ;;
  container)
    echo "FAIL: --target container needs the Phase 8 S2 target link; S1 supports --target local only." >&2
    exit 2
    ;;
  ssh)
    echo "FAIL: --target ssh needs Phase 8 S3/S4 (and OPENSAND_SSH_TARGET); S1 supports --target local only." >&2
    exit 2
    ;;
  *)
    echo "FAIL: unknown target '$TARGET' (known: local, container, ssh)." >&2
    exit 2
    ;;
esac

FIXTURES="$ROOT/evals/mission-suite"
for fixture in verified false-claim repair budget changed-lines; do
  [[ -f "$FIXTURES/$fixture.json" ]] || {
    echo "FAIL: missing fixture evals/mission-suite/$fixture.json" >&2
    exit 1
  }
done

echo "==> building shared, protocol, daemon and engine"
pnpm --filter "@opensand/engine..." build >/dev/null

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/opensand-mission-suite.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

cat > "$STAGE/driver.mjs" <<'DRIVER'
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const [root, stage, fixturesDir, target] = process.argv.slice(2);
const shared = await import(pathToFileURL(path.join(root, "packages/shared/dist/src/index.js")).href);
const ENGINE = path.join(root, "packages/engine/dist/src/bin.js");

function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: cleanGitEnv() });
}

function parseDiff(diffText) {
  const files = [];
  let current = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ b/")) {
      current = { file: line.slice(6), ranges: [] };
      files.push(current);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      current.ranges.push([start, start + count - 1]);
    }
  }
  return files.filter((file) => file.ranges.length > 0);
}

async function runMission(name) {
  const fixturePath = path.join(fixturesDir, `${name}.json`);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const dir = path.join(stage, name);
  const stateDir = path.join(dir, "state");
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  for (const [rel, content] of Object.entries(fixture.seed ?? {})) {
    const full = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  git(["init", "-q"], workspace);
  git(["config", "user.email", "suite@opensand.local"], workspace);
  git(["config", "user.name", "OpenSand Mission Suite"], workspace);
  git(["add", "-A"], workspace);
  git(["commit", "-q", "--no-gpg-sign", "-m", "base"], workspace);

  const key = shared.FolderTrustStore.canonicalFolder(workspace);
  fs.writeFileSync(
    path.join(stateDir, "folder-trust.json"),
    JSON.stringify({ version: 1, folders: { [key]: { level: "trusted", updatedAt: Date.now(), updatedBy: "mission-suite" } } }),
  );

  const child = spawn(
    process.execPath,
    [ENGINE, "--stdio", "--state-dir", stateDir, "--scripted-agent", fixturePath],
    { env: { ...cleanGitEnv(), HOME: path.join(dir, "user-home") }, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  let buffer = "";
  const waiters = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      const waiter = frame.id && waiters.get(frame.id);
      if (waiter) { waiters.delete(frame.id); waiter(frame); }
    }
  });

  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr: ${stderr.slice(-2000)}`)), 30_000);
      waiters.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });

  try {
    const started = await request("start", "mission.Missions.start", {
      workspaceRoot: workspace,
      title: fixture.title,
      initialQuery: fixture.initialQuery,
      checkCommand: fixture.checkCommand,
      maxRepairs: fixture.maxRepairs,
      wallClockMs: 120_000,
    });
    if (started.error) throw new Error(`mission start refused: ${JSON.stringify(started.error)}`);
    const missionId = started.result.missionId;

    let final;
    const deadline = Date.now() + 60_000;
    for (let i = 0; Date.now() < deadline; i++) {
      const got = await request(`get-${i}`, "mission.Missions.get", { missionId });
      final = got.result;
      if (final && ["verified", "failed", "stopped"].includes(final.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!final || !["verified", "failed", "stopped"].includes(final.status)) {
      throw new Error(`${name} did not finish; last status ${JSON.stringify(final)}; stderr: ${stderr.slice(-2000)}`);
    }

    const events = await new shared.EventLogReader(path.join(stateDir, "missions", missionId)).readAll();
    const checks = events.filter((event) => event.kind === "check.completed");
    return { name, status: final.status, receipt: final.receipt, events, checks, workspace };
  } finally {
    child.kill("SIGKILL");
  }
}

/** Target identity is asserted from the check's own output, and from the
 * receipt's target block once Phase 8 S4 adds it. */
function assertTargetIdentity(result) {
  const lastCheck = result.checks.at(-1);
  assert.ok(lastCheck, "the mission ran at least one check");
  assert.match(
    String(lastCheck.data?.outputTail ?? ""),
    new RegExp(`target=${target}`),
    `the last check's output names target=${target}`,
  );
  const block = result.receipt?.target;
  assert.ok(!block || block.kind === "local", "the receipt's target block, when present, names the local kind");
}

const cases = {
  verified(result) {
    assert.equal(result.status, "verified", "verified mission ends verified");
    assert.equal(result.receipt?.status, "VERIFIED", "the receipt says VERIFIED");
    const file = (result.receipt?.changed ?? []).find((change) => change.file === "out.txt");
    assert.ok(file && file.ranges.length > 0, "out.txt is in the changed-lines receipt");
    assert.equal(fs.readFileSync(path.join(result.workspace, "out.txt"), "utf8"), "ok\n", "out.txt is on disk");
    assert.equal(result.events.filter((event) => event.kind === "mission.verified").length, 1, "one mission.verified event");
    assertTargetIdentity(result);
  },

  "false-claim"(result) {
    assert.equal(result.status, "failed", "a false claim ends failed");
    assert.equal(result.receipt?.status, "FAILED", "the receipt says FAILED");
    assert.equal(result.events.filter((event) => event.kind === "mission.verified").length, 0, "the claim never produces mission.verified");
    assert.ok(result.checks.length > 0 && result.checks.every((check) => check.data?.passed === false), "every check failed");
    assert.deepEqual(result.receipt?.changed ?? [], [], "nothing changed on disk");
    assert.ok(
      result.events.some((event) => event.kind === "node.completed" && event.data?.claim === "all tests pass"),
      "the agent did claim all tests pass",
    );
  },

  repair(result) {
    assert.equal(result.status, "verified", "mission ends verified after a repair");
    assert.equal(result.checks.length, 2, "exactly two checks ran");
    assert.equal(result.checks[0].data?.passed, false, "the first check failed");
    assert.equal(result.checks[1].data?.passed, true, "the second check passed");
    assert.equal(result.events.filter((event) => event.kind === "mission.verified").length, 1, "one mission.verified event");
  },

  budget(result) {
    assert.equal(result.status, "failed", "mission ends failed when the repair budget is spent");
    assert.equal(result.checks.length, 2, "maxRepairs=1 gives two checks");
    assert.ok(result.checks.every((check) => check.data?.passed === false), "no check passed");
    assert.equal(result.events.filter((event) => event.kind === "mission.verified").length, 0, "the claim never wins");
    const claims = result.events.filter((event) => event.kind === "node.completed" && event.data?.node === "act");
    assert.ok(claims.length > 0 && claims.every((event) => event.data?.claim === "all tests pass"), "every round claimed success");
  },

  "changed-lines"(result) {
    assert.equal(result.status, "verified", "mission ends verified");
    const expected = parseDiff(git(["diff", "--unified=0", "--no-color", "HEAD"], result.workspace));
    assert.deepEqual(
      (result.receipt?.changed ?? []).map((change) => ({ file: change.file, ranges: change.ranges })),
      expected,
      "the receipt's changed lines equal an independent git diff parse",
    );
    assert.deepEqual(expected, [{ file: "src.txt", ranges: [[2, 2]] }], "exactly line 2 of src.txt changed");
  },
};

const order = ["verified", "false-claim", "repair", "budget", "changed-lines"];
for (let i = 0; i < order.length; i++) {
  const name = order[i];
  const result = await runMission(name);
  try {
    cases[name](result);
  } catch (error) {
    console.error(`FAIL: mission ${i + 1}/5 ${name}: ${error.message}`);
    console.error(`      status=${result.status} checks=${result.checks.map((check) => check.data?.passed).join(",")}`);
    process.exit(1);
  }
  console.log(`==> mission ${i + 1}/5 ${name}: ok (${result.status})`);
}

console.log(`${order.length}/${order.length} missions passed on ${target}`);
DRIVER

echo "==> [suite] five scripted missions on target '$TARGET'"
node "$STAGE/driver.mjs" "$ROOT" "$STAGE" "$FIXTURES" "$TARGET"
