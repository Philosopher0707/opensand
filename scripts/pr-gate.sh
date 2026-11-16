#!/usr/bin/env bash
# Pre-merge gate for OpenSand PRs: runs checks 1-5 and merges only when all pass.
# Usage: scripts/pr-gate.sh [--dry-run] [--allow-lockfile] [--allow-binary] [--when-green [--timeout <min>]] <PR-number>
#
# --when-green  First wait for pending CI with `gh pr checks --watch` (bounded by
#               --timeout minutes, default 40), then run the normal 5 checks and merge.
#               Red CI exits 1 and names the failing job; a timeout exits 3.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
ALLOW_LOCKFILE=0
ALLOW_BINARY=0
WHEN_GREEN=0
TIMEOUT_MIN=40
# Seconds per --timeout unit (60 = minutes); only the selftest overrides it.
TIMEOUT_UNIT_SECONDS="${PR_GATE_TIMEOUT_UNIT_SECONDS:-60}"
PR=""
USAGE="Usage: scripts/pr-gate.sh [--dry-run] [--allow-lockfile] [--allow-binary] [--when-green [--timeout <min>]] <PR-number>"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --allow-lockfile)
      ALLOW_LOCKFILE=1
      shift
      ;;
    --allow-binary)
      ALLOW_BINARY=1
      shift
      ;;
    --when-green)
      WHEN_GREEN=1
      shift
      ;;
    --timeout)
      if [[ $# -lt 2 || ! "$2" =~ ^[1-9][0-9]*$ ]]; then
        echo "FAIL: --timeout needs a positive whole number of minutes" >&2
        exit 1
      fi
      TIMEOUT_MIN="$2"
      shift 2
      ;;
    -h|--help)
      echo "$USAGE"
      exit 0
      ;;
    *)
      if [[ -z "$PR" && "$1" =~ ^[0-9]+$ ]]; then
        PR="$1"
        shift
      else
        echo "FAIL: unknown argument or invalid PR number: $1" >&2
        echo "$USAGE" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$PR" ]]; then
  echo "FAIL: missing PR number" >&2
  echo "$USAGE" >&2
  exit 1
fi

if [[ "$WHEN_GREEN" -eq 1 ]]; then
  echo "==> [when-green] Watching CI for PR #$PR (timeout ${TIMEOUT_MIN} min)..."
  DEADLINE=$((SECONDS + TIMEOUT_MIN * TIMEOUT_UNIT_SECONDS))
  POLL_SECONDS="${PR_GATE_POLL_SECONDS:-5}"

  # CI registers a few seconds after a push or PR creation, and `gh pr checks` fails with "no checks
  # reported" until then: wait (inside the same deadline) for the first check to appear.
  while ROLLUP_JSON=$(gh pr view "$PR" --json statusCheckRollup 2>/dev/null); do
    ROLLUP_COUNT=$(node -e 'console.log(((JSON.parse(process.argv[1]).statusCheckRollup) || []).length)' "$ROLLUP_JSON" 2>/dev/null || echo 1)
    [[ "$ROLLUP_COUNT" =~ ^[0-9]+$ && "$ROLLUP_COUNT" -eq 0 ]] || break
    if [[ "$SECONDS" -ge "$DEADLINE" ]]; then
      echo "FAIL: --when-green timed out after ${TIMEOUT_MIN} min: no CI checks were reported for PR #$PR" >&2
      exit 3
    fi
    sleep "$POLL_SECONDS"
  done

  gh pr checks "$PR" --watch &
  WATCH_PID=$!
  TIMED_OUT=0
  # One bounded poll of our own child (no timeout binary on macOS); gh does the real CI polling.
  while kill -0 "$WATCH_PID" 2>/dev/null; do
    if [[ "$SECONDS" -ge "$DEADLINE" ]]; then
      TIMED_OUT=1
      kill "$WATCH_PID" 2>/dev/null || true
      break
    fi
    sleep 1
  done
  WATCH_STATUS=0
  wait "$WATCH_PID" 2>/dev/null || WATCH_STATUS=$?

  if [[ "$TIMED_OUT" -eq 1 ]]; then
    echo "FAIL: --when-green timed out after ${TIMEOUT_MIN} min: CI for PR #$PR is still pending" >&2
    exit 3
  fi

  if [[ "$WATCH_STATUS" -ne 0 ]]; then
    RED_JOBS=""
    if WATCH_JSON=$(gh pr view "$PR" --json statusCheckRollup 2>/dev/null); then
      RED_JOBS=$(node -e '
const rollup = (JSON.parse(process.argv[1]).statusCheckRollup) || [];
const bad = rollup.filter(j => {
  const c = (j.conclusion || "").toUpperCase();
  return c && !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c);
});
console.log(bad.map(j => j.name + " (" + (j.conclusion || "").toUpperCase() + ")").join(", "));
' "$WATCH_JSON" 2>/dev/null || true)
    fi
    if [[ -n "$RED_JOBS" ]]; then
      echo "FAIL: CI is red for PR #$PR: $RED_JOBS" >&2
    else
      echo "FAIL: gh pr checks --watch exited $WATCH_STATUS for PR #$PR and no failing job could be identified" >&2
    fi
    exit 1
  fi
  echo "PASS: [when-green] CI finished green for PR #$PR; continuing with the normal checks."
fi

echo "==> [Check 1/5] Checking PR #$PR status and CI rollups..."
if ! PR_JSON=$(gh pr view "$PR" --json state,isDraft,mergeable,baseRefOid,headRefOid,statusCheckRollup 2>&1); then
  echo "FAIL: gh pr view failed for PR #$PR: $PR_JSON" >&2
  exit 1
fi

CHECK1_STATUS=0
CHECK1_OUT=$(node -e '
const raw = process.argv[1];
const pr = process.argv[2];
let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error("FAIL: unable to parse PR #" + pr + " JSON: " + e.message);
  process.exit(1);
}

if (data.state !== "OPEN") {
  console.error("FAIL: PR state is " + data.state + ", expected OPEN");
  process.exit(1);
}

if (data.isDraft === true) {
  console.error("FAIL: PR #" + pr + " is still a draft (scripts/worktree.sh save opens drafts); GitHub refuses to merge a draft, and the checkpoint tag would already be pushed. Run: gh pr ready " + pr);
  process.exit(1);
}

if (data.mergeable !== "MERGEABLE") {
  console.error("FAIL: PR mergeable status is " + data.mergeable + ", expected MERGEABLE");
  process.exit(1);
}

const rollup = data.statusCheckRollup || [];
const linuxJob = rollup.find(j => j.name === "Build & test (Node 22)" || (j.name && j.name.includes("Node 22") && !j.name.includes("macOS")));
const macJob = rollup.find(j => j.name === "Build & test (macOS, Node 22)" || (j.name && j.name.includes("macOS")));

if (!linuxJob || !macJob) {
  console.error("FAIL: Missing required CI jobs in statusCheckRollup (Linux: " + (linuxJob ? "found" : "missing") + ", macOS: " + (macJob ? "found" : "missing") + ")");
  process.exit(3);
}

for (const [osName, job] of [["Linux", linuxJob], ["macOS", macJob]]) {
  const status = (job.status || "").toUpperCase();
  const conclusion = (job.conclusion || "").toUpperCase();
  if (status !== "COMPLETED" || !conclusion || conclusion === "PENDING") {
    console.error("FAIL: CI job for " + osName + " (" + job.name + ") is not completed (status: " + (status || "unknown") + ", conclusion: " + (conclusion || "none") + ")");
    process.exit(3);
  }
  if (conclusion !== "SUCCESS") {
    console.error("FAIL: CI job for " + osName + " (" + job.name + ") failed with conclusion: " + conclusion);
    process.exit(1);
  }
}

console.log("PASS: PR #" + pr + " is OPEN, MERGEABLE, and both CI jobs (Linux, macOS) succeeded on head " + data.headRefOid);
' "$PR_JSON" "$PR" 2>&1) || CHECK1_STATUS=$?

if [[ "$CHECK1_STATUS" -ne 0 ]]; then
  echo "$CHECK1_OUT" >&2
  exit "$CHECK1_STATUS"
fi
echo "$CHECK1_OUT"

BASE_REF_OID=$(node -e 'console.log(JSON.parse(process.argv[1]).baseRefOid || "")' "$PR_JSON")
HEAD_REF_OID=$(node -e 'console.log(JSON.parse(process.argv[1]).headRefOid || "")' "$PR_JSON")

echo "==> [Check 2/5] Checking that PR base is up to date with origin/main..."
if ! REMOTE_MAIN_LINE=$(git ls-remote origin refs/heads/main 2>&1); then
  echo "FAIL: git ls-remote failed for origin refs/heads/main: $REMOTE_MAIN_LINE" >&2
  exit 1
fi
REMOTE_MAIN_SHA=$(echo "$REMOTE_MAIN_LINE" | awk '{print $1}')
if [[ -z "$REMOTE_MAIN_SHA" ]]; then
  echo "FAIL: unable to determine remote sha for refs/heads/main from origin" >&2
  exit 1
fi

if [[ "$BASE_REF_OID" != "$REMOTE_MAIN_SHA" ]]; then
  echo "FAIL: PR base is out of date: PR baseRefOid ($BASE_REF_OID) does not match origin/main ($REMOTE_MAIN_SHA)" >&2
  exit 1
fi
echo "PASS: PR base is up to date with origin/main ($REMOTE_MAIN_SHA)"

echo "==> [Check 3/5] Checking for forbidden files in PR diff..."
if ! DIFF_NAMES=$(gh pr diff "$PR" --name-only 2>&1); then
  echo "FAIL: gh pr diff --name-only failed for PR #$PR: $DIFF_NAMES" >&2
  exit 1
fi
if ! FULL_DIFF=$(gh pr diff "$PR" 2>&1); then
  echo "FAIL: gh pr diff failed for PR #$PR: $FULL_DIFF" >&2
  exit 1
fi

CHECK3_STATUS=0
CHECK3_OUT=$(node -e '
const namesRaw = process.argv[1];
const fullDiff = process.argv[2];
const allowLockfile = process.argv[3] === "1";
const allowBinary = process.argv[4] === "1";

const files = namesRaw.split("\n").map(s => s.trim()).filter(Boolean);

const binRegex = /^Binary files (?:a\/(.+?)|[^\s]+) and (?:b\/(.+?)|[^\s]+) differ$/gm;
const binaryDiffFiles = new Set();
let m;
while ((m = binRegex.exec(fullDiff)) !== null) {
  if (m[1]) binaryDiffFiles.add(m[1]);
  if (m[2]) binaryDiffFiles.add(m[2]);
}
const gitBinPatchRegex = /^diff --git a\/(.+?) b\/(.+?)\n(?:new file[^\n]*\n)?GIT binary patch/gm;
while ((m = gitBinPatchRegex.exec(fullDiff)) !== null) {
  if (m[1]) binaryDiffFiles.add(m[1]);
  if (m[2]) binaryDiffFiles.add(m[2]);
}

for (const f of files) {
  const base = f.split("/").pop();
  if (base === "pnpm-lock.yaml") {
    if (!allowLockfile) {
      console.error("FAIL: forbidden file in diff: " + f + " (pass --allow-lockfile to override)");
      process.exit(1);
    } else {
      console.log("WARNING: --allow-lockfile passed: allowing lockfile changes in diff: " + f);
    }
  }

  if (f === ".github" || f.startsWith(".github/")) {
    console.error("FAIL: forbidden file in diff: " + f + " (changes under .github/ are forbidden)");
    process.exit(1);
  }

  const isBinExt = /\.(png|jpe?g|zip|dmg)$/i.test(f);
  const isGitBin = binaryDiffFiles.has(f);
  if (isBinExt || isGitBin) {
    if (!allowBinary) {
      console.error("FAIL: forbidden binary file in diff: " + f + " (pass --allow-binary to override)");
      process.exit(1);
    } else {
      console.log("WARNING: --allow-binary passed: allowing binary file in diff: " + f);
    }
  }
}

console.log("PASS: no forbidden files in diff (checked lockfile, .github/, and binaries)");
' "$DIFF_NAMES" "$FULL_DIFF" "$ALLOW_LOCKFILE" "$ALLOW_BINARY" 2>&1) || CHECK3_STATUS=$?

if [[ "$CHECK3_STATUS" -ne 0 ]]; then
  echo "$CHECK3_OUT" >&2
  exit "$CHECK3_STATUS"
fi
echo "$CHECK3_OUT"

DATE=$(date +%Y-%m-%d)
TAG="checkpoint/${DATE}/main-before-pr-${PR}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN: all pre-merge checks passed."
  echo "DRY RUN: would create and push tag '$TAG' pointing at '$REMOTE_MAIN_SHA'"
  echo "DRY RUN: would merge PR #$PR via 'gh pr merge $PR --merge'"
  exit 0
fi

echo "==> [Check 4/5] Creating and verifying checkpoint tag..."
git tag -f "$TAG" "$REMOTE_MAIN_SHA"
echo "Pushing checkpoint tag $TAG to origin..."
if ! git push origin "refs/tags/$TAG:refs/tags/$TAG"; then
  echo "FAIL: failed to push checkpoint tag $TAG to origin" >&2
  exit 1
fi

echo "Verifying checkpoint tag $TAG on origin..."
if ! TAG_REMOTE_LINE=$(git ls-remote --tags origin "$TAG" 2>&1); then
  echo "FAIL: git ls-remote --tags failed for tag $TAG: $TAG_REMOTE_LINE" >&2
  exit 1
fi
TAG_REMOTE_SHA=$(echo "$TAG_REMOTE_LINE" | awk '{print $1}' | head -n 1)
if [[ -z "$TAG_REMOTE_SHA" || "$TAG_REMOTE_SHA" != "$REMOTE_MAIN_SHA" ]]; then
  echo "FAIL: checkpoint tag verification failed: expected $REMOTE_MAIN_SHA, got '\''${TAG_REMOTE_SHA}'\''" >&2
  exit 1
fi
echo "PASS: checkpoint tag $TAG verified on origin pointing to $REMOTE_MAIN_SHA"

echo "==> [Check 5/5] Merging PR #$PR..."
if ! gh pr merge "$PR" --merge; then
  echo "FAIL: gh pr merge failed for PR #$PR" >&2
  exit 1
fi

if ! MERGE_VIEW=$(gh pr view "$PR" --json mergeCommit,state 2>&1); then
  echo "FAIL: gh pr view --json mergeCommit,state failed for PR #$PR: $MERGE_VIEW" >&2
  exit 1
fi

MERGE_COMMIT=$(node -e 'const d = JSON.parse(process.argv[1]); console.log((d.mergeCommit && d.mergeCommit.oid) || d.mergeCommit || "unknown");' "$MERGE_VIEW")
PR_STATE=$(node -e 'const d = JSON.parse(process.argv[1]); console.log(d.state || "unknown");' "$MERGE_VIEW")

echo "PASS: PR #$PR merged successfully."
echo "Merge commit: $MERGE_COMMIT"
echo "State: $PR_STATE"
