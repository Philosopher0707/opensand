#!/usr/bin/env bash
# Pre-merge gate for OpenSand PRs: runs checks 1-5 and merges only when all pass.
# Usage: scripts/pr-gate.sh [--dry-run] [--allow-lockfile] [--allow-binary] [--allow-github] [--when-green [--timeout <min>]] [--no-post-merge-check] [--no-review "<reason>"] <PR-number>
#
# A PR needs the `rigel-pass` label before it can merge; --no-review "<reason>" is the only
# escape hatch and records the reason in the merge commit body. A stale base (Check 2) is
# updated with `gh pr update-branch` and exits 3 for a re-run; this script never waits on CI here.
#
# --when-green  First wait for pending CI with `gh pr checks --watch` (bounded by
#               --timeout minutes, default 40), then run the normal 5 checks and merge.
#               Red CI exits 1 and names the failing job; a timeout exits 3. "No checks
#               reported" is pending for up to 5 min (or --timeout, if sooner); a queued or
#               in-progress workflow run for the head commit (read from the per-run Jobs API,
#               since `gh run list` status can lag) extends that wait, bounded by
#               PR_GATE_QUEUED_RUN_MAX_SECONDS (default 600), then exits 3 with
#               "no CI checks appeared after <N>s".
#               A PR whose base is behind origin/main is rebased onto it and pushed with
#               --force-with-lease before the wait, then its new CI is awaited. A
#               conflicting rebase stops with the conflicting files named, nothing pushed.
#
# After a merge the gate waits for the CI run on main for the merge commit with the same
# bounded deadline (--timeout, default 40 min; a not-yet-registered run is pending, not
# red). Green prints "main CI green for <sha>" and exits 0; red names the failing jobs and
# the `gh run view <id> --log-failed` hint and exits 4; a pending/no-run timeout exits 3.
# --no-post-merge-check skips that wait.
#
# Re-running the gate on a PR that is already MERGED is safe: it prints "PR #<n> already merged as
# <sha>" and only runs the post-merge main CI check for that merge commit (exit 0 green, 4 red, 3
# pending). It never rebases, tags or pushes the merged branch.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT/scripts"

source "$SCRIPT_DIR/lib/owner-guard.sh"
assert_not_owner_checkout "pr-gate.sh"

cd "$ROOT"

DRY_RUN=0
ALLOW_LOCKFILE=0
ALLOW_BINARY=0
ALLOW_GITHUB=0
WHEN_GREEN=0
POST_MERGE_CHECK=1
NO_REVIEW=0
NO_REVIEW_REASON=""
TIMEOUT_MIN=40
# Seconds per --timeout unit (60 = minutes); only the selftest overrides it.
TIMEOUT_UNIT_SECONDS="${PR_GATE_TIMEOUT_UNIT_SECONDS:-60}"
PR=""
USAGE="Usage: scripts/pr-gate.sh [--dry-run] [--allow-lockfile] [--allow-binary] [--allow-github] [--when-green [--timeout <min>]] [--no-post-merge-check] [--no-review \"<reason>\"] <PR-number>"

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
    --allow-github)
      ALLOW_GITHUB=1
      shift
      ;;
    --when-green)
      WHEN_GREEN=1
      shift
      ;;
    --no-post-merge-check)
      POST_MERGE_CHECK=0
      shift
      ;;
    --no-review)
      if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
        echo "FAIL: --no-review requires a reason" >&2
        exit 1
      fi
      NO_REVIEW=1
      NO_REVIEW_REASON="$2"
      shift 2
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

post_merge_check() {
  local merge_sha="$1"
  local pm_start=$SECONDS
  local pm_deadline=$((SECONDS + TIMEOUT_MIN * TIMEOUT_UNIT_SECONDS))
  local pm_poll="${PR_GATE_POLL_SECONDS:-5}"
  # GitHub registers a workflow run a few seconds after the push: pending, not red.
  local pm_grace="${PR_GATE_NO_CHECKS_GRACE_SECONDS:-300}"
  local pm_no_run_deadline=$((pm_start + pm_grace))
  if [[ "$pm_no_run_deadline" -gt "$pm_deadline" ]]; then pm_no_run_deadline="$pm_deadline"; fi
  local runs_json run_json run_id pm_status pm_conclusion red_jobs

  echo "==> [post-merge] Waiting for main CI run for $merge_sha (timeout ${TIMEOUT_MIN} min)..."

  while :; do
    run_id=""
    if runs_json=$(gh run list --commit "$merge_sha" --json databaseId,name,event,headBranch 2>/dev/null); then
      run_id=$(node -e '
const runs = JSON.parse(process.argv[1] || "[]") || [];
const onMain = runs.filter(r => (r.headBranch === "main" || r.headBranch === "refs/heads/main") && (r.event === "push" || !r.event));
const pick = onMain.find(r => (r.name || "").toLowerCase() === "ci") || onMain[0];
console.log(pick ? pick.databaseId : "");
' "$runs_json" 2>/dev/null || true)
    fi
    [[ -n "$run_id" ]] && break
    if [[ "$SECONDS" -ge "$pm_no_run_deadline" ]]; then
      echo "FAIL: main CI run never appeared after $((SECONDS - pm_start))s for $merge_sha" >&2
      exit 3
    fi
    sleep "$pm_poll"
  done

  echo "==> [post-merge] Found main CI run $run_id; waiting for it to finish..."

  while :; do
    if run_json=$(gh run view "$run_id" --json status,conclusion,jobs 2>/dev/null); then
      pm_status=$(node -e 'const d=JSON.parse(process.argv[1]||"{}");console.log((d.status||"").toUpperCase())' "$run_json" 2>/dev/null || true)
      pm_conclusion=$(node -e 'const d=JSON.parse(process.argv[1]||"{}");console.log((d.conclusion||"").toUpperCase())' "$run_json" 2>/dev/null || true)
      if [[ "$pm_status" == "COMPLETED" ]]; then
        if [[ "$pm_conclusion" == "SUCCESS" ]]; then
          echo "main CI green for $merge_sha"
          return 0
        fi
        red_jobs=$(node -e '
const d = JSON.parse(process.argv[1] || "{}");
const bad = (d.jobs || []).filter(j => {
  const c = (j.conclusion || "").toUpperCase();
  return c && !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c);
});
console.log(bad.map(j => j.name + " (" + (j.conclusion || "").toUpperCase() + ")").join(", "));
' "$run_json" 2>/dev/null || true)
        [[ -z "$red_jobs" ]] && red_jobs="$pm_conclusion"
        echo "FAIL: main CI red for $merge_sha: $red_jobs" >&2
        echo "Inspect with: gh run view $run_id --log-failed" >&2
        exit 4
      fi
    fi
    if [[ "$SECONDS" -ge "$pm_deadline" ]]; then
      echo "FAIL: main CI still pending after ${TIMEOUT_MIN} min for $merge_sha (run $run_id)" >&2
      exit 3
    fi
    sleep "$pm_poll"
  done
}

# An already-merged PR is done: a re-run must never rebase, tag or push it again. Only the
# post-merge main CI check for its merge commit runs, so re-running the gate is idempotent.
if MERGED_JSON=$(gh pr view "$PR" --json state,mergeCommit,number 2>/dev/null); then
  MERGED_STATE=$(node -e 'const d=JSON.parse(process.argv[1]||"{}");console.log((d.state||"").toUpperCase())' "$MERGED_JSON" 2>/dev/null || true)
  if [[ "$MERGED_STATE" == "MERGED" ]]; then
    MERGED_SHA=$(node -e 'const d=JSON.parse(process.argv[1]||"{}");const m=d.mergeCommit;console.log((m&&m.oid)||m||"unknown")' "$MERGED_JSON" 2>/dev/null || true)
    MERGED_SHA="${MERGED_SHA:-unknown}"
    echo "PR #$PR already merged as $MERGED_SHA"
    if [[ "$POST_MERGE_CHECK" -eq 0 || "$DRY_RUN" -eq 1 ]]; then
      exit 0
    fi
    post_merge_check "$MERGED_SHA"
    exit 0
  fi
fi

if [[ "$WHEN_GREEN" -eq 1 ]]; then
  echo "==> [when-green] Watching CI for PR #$PR (timeout ${TIMEOUT_MIN} min)..."
  DEADLINE=$((SECONDS + TIMEOUT_MIN * TIMEOUT_UNIT_SECONDS))
  POLL_SECONDS="${PR_GATE_POLL_SECONDS:-5}"
  # CI registers its checks a few seconds after a push or PR creation, and until then `gh pr checks`
  # fails with "no checks reported": that is pending, not red. Wait for them, bounded by a 5-minute
  # grace period (or the --timeout deadline, whichever is sooner). A workflow run can already be
  # queued before GitHub registers any check on the PR, so a queued/in-progress run for the head
  # commit extends the grace period, itself bounded by PR_GATE_QUEUED_RUN_MAX_SECONDS (default 600).
  NO_CHECKS_GRACE_SECONDS="${PR_GATE_NO_CHECKS_GRACE_SECONDS:-300}"
  QUEUED_RUN_MAX_SECONDS="${PR_GATE_QUEUED_RUN_MAX_SECONDS:-600}"
  # The window starts at the push, not at process start: a rebase force-push produces a new SHA
  # whose checks need their own grace period. SECONDS, DEADLINE and both limits are in scope here.
  reset_no_checks_window() {
    NO_CHECKS_DEADLINE=$((SECONDS + NO_CHECKS_GRACE_SECONDS))
    if [[ "$NO_CHECKS_DEADLINE" -gt "$DEADLINE" ]]; then
      NO_CHECKS_DEADLINE="$DEADLINE"
    fi
    NO_CHECKS_SINCE=$SECONDS
    NO_CHECKS_HARD_DEADLINE=$((NO_CHECKS_SINCE + QUEUED_RUN_MAX_SECONDS))
    if [[ "$NO_CHECKS_HARD_DEADLINE" -gt "$DEADLINE" ]]; then
      NO_CHECKS_HARD_DEADLINE="$DEADLINE"
    fi
  }
  reset_no_checks_window
  CHECKS_OUT="$(mktemp "${TMPDIR:-/tmp}/pr-gate-checks.XXXXXX")"
  REBASE_DIR=""
  REBASE_WT=""
  REBASE_REF=""
  cleanup_rebase() {
    rm -f "$CHECKS_OUT"
    if [[ -n "$REBASE_WT" ]]; then
      git worktree remove --force "$REBASE_WT" >/dev/null 2>&1 || rm -rf "$REBASE_WT"
    fi
    if [[ -n "$REBASE_REF" ]]; then
      git update-ref -d "$REBASE_REF" >/dev/null 2>&1 || true
    fi
    if [[ -n "$REBASE_DIR" ]]; then
      rm -rf "$REBASE_DIR"
    fi
  }
  trap cleanup_rebase EXIT
  # A queued workflow run is pending CI, not a missing check. The per-run Jobs API is the source
  # of truth because `gh run list` status can lag the real job state; fail closed if gh cannot
  # be read. On success sets QUEUED_DESC to the still-running jobs, for progress and failure
  # messages.
  queued_run_for_head() {
    QUEUED_DESC=""
    local head_json head_sha runs_json run_id jobs_json names
    head_json=$(gh pr view "$PR" --json headRefOid 2>/dev/null) || return 1
    head_sha=$(node -e 'try{console.log((JSON.parse(process.argv[1]).headRefOid)||"")}catch{process.exit(1)}' "$head_json" 2>/dev/null || true)
    [[ -n "$head_sha" ]] || return 1
    # `gh run list --commit` only names the candidate runs; run state comes from the Jobs API,
    # so a stale status there (e.g. COMPLETED while a job is still in progress) cannot hide a
    # pending run.
    runs_json=$(gh run list --commit "$head_sha" --json databaseId,headSha 2>/dev/null) || return 1
    while IFS= read -r run_id; do
      [[ -n "$run_id" ]] || continue
      jobs_json=$(gh api "repos/{owner}/{repo}/actions/runs/$run_id/jobs" 2>/dev/null) || return 1
      names=$(node -e '
const data = JSON.parse(process.argv[1] || "{}");
const jobs = Array.isArray(data.jobs) ? data.jobs : [];
const pending = ["queued", "in_progress", "pending", "waiting", "requested"];
// A run whose jobs have not materialized yet has not started: still running.
if (jobs.length === 0) {
  console.log("no jobs reported yet");
} else {
  const still = jobs.filter((j) => pending.includes(String(j.status || "").toLowerCase()))
    .map((j) => j.name + " (" + (j.status || "unknown") + ")");
  if (still.length > 0) console.log(still.join(", "));
}
' "$jobs_json" 2>/dev/null) || return 1
      if [[ -n "$names" ]]; then
        QUEUED_DESC="${QUEUED_DESC:+$QUEUED_DESC; }run #$run_id: $names"
      fi
    done < <(node -e '
const runs = JSON.parse(process.argv[1] || "[]");
const sha = process.argv[2];
for (const run of (Array.isArray(runs) ? runs : [])) {
  if (!run.headSha || run.headSha === sha) console.log(run.databaseId);
}
' "$runs_json" "$head_sha" 2>/dev/null)
    [[ -n "$QUEUED_DESC" ]]
  }

  no_checks_fail() {
    if queued_run_for_head && [[ "$SECONDS" -lt "$NO_CHECKS_HARD_DEADLINE" ]]; then
      echo "==> [when-green] CI run for head commit is queued/in progress ($QUEUED_DESC); waiting for checks to register..."
      NO_CHECKS_DEADLINE=$((SECONDS + NO_CHECKS_GRACE_SECONDS))
      if [[ "$NO_CHECKS_DEADLINE" -gt "$NO_CHECKS_HARD_DEADLINE" ]]; then
        NO_CHECKS_DEADLINE="$NO_CHECKS_HARD_DEADLINE"
      fi
      return 0
    fi
    if [[ -n "$QUEUED_DESC" ]]; then
      echo "FAIL: no CI checks appeared after $((SECONDS - NO_CHECKS_SINCE))s for PR #$PR; CI still queued: $QUEUED_DESC" >&2
    else
      echo "FAIL: no CI checks appeared after $((SECONDS - NO_CHECKS_SINCE))s for PR #$PR" >&2
    fi
    exit 3
  }

  # Rebase a PR that fell behind origin/main onto it. Main can move again while CI runs, so the
  # rebase + wait cycle is bounded at 3 attempts. A conflicting rebase is aborted with the
  # conflicting files named and nothing pushed.
  wait_for_green() {
    # First wait for the check list to register at all, so the watch has something to watch.
    while ROLLUP_JSON=$(gh pr view "$PR" --json statusCheckRollup 2>/dev/null); do
      ROLLUP_COUNT=$(node -e 'console.log(((JSON.parse(process.argv[1]).statusCheckRollup) || []).length)' "$ROLLUP_JSON" 2>/dev/null || echo 1)
      [[ "$ROLLUP_COUNT" =~ ^[0-9]+$ && "$ROLLUP_COUNT" -eq 0 ]] || break
      if [[ "$SECONDS" -ge "$NO_CHECKS_DEADLINE" ]]; then
        no_checks_fail
      fi
      sleep "$POLL_SECONDS"
    done

    while :; do
      : > "$CHECKS_OUT"
      gh pr checks "$PR" --watch >"$CHECKS_OUT" 2>&1 &
      WATCH_PID=$!
      TIMED_OUT=0
      PRINTED=0
      # One bounded poll of our own child (no timeout binary on macOS); gh does the real CI polling.
      while kill -0 "$WATCH_PID" 2>/dev/null; do
        # Echo each new line gh printed, so a long watch still shows progress.
        TOTAL_LINES=$(wc -l < "$CHECKS_OUT" 2>/dev/null || echo 0)
        if [[ "$TOTAL_LINES" -gt "$PRINTED" ]]; then
          tail -n +"$((PRINTED + 1))" "$CHECKS_OUT"
          PRINTED="$TOTAL_LINES"
        fi
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

      [[ "$WATCH_STATUS" -eq 0 ]] && break

      # A watch can still start before GitHub registered the check list: wait and retry.
      if grep -qi "no checks reported" "$CHECKS_OUT"; then
        if [[ "$SECONDS" -ge "$NO_CHECKS_DEADLINE" ]]; then
          no_checks_fail
        fi
        sleep "$POLL_SECONDS"
        continue
      fi

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
    done
    echo "PASS: [when-green] CI finished green for PR #$PR; continuing with the normal checks."
  }

  REBASE_MAX="${PR_GATE_REBASE_ATTEMPTS:-3}"
  ATTEMPT=0
  while :; do
    if [[ "$ATTEMPT" -ge "$REBASE_MAX" ]]; then
      echo "FAIL: PR #$PR is still behind origin/main after $REBASE_MAX rebase attempts" >&2
      exit 1
    fi
    ATTEMPT=$((ATTEMPT + 1))

    if ! PR_META=$(gh pr view "$PR" --json baseRefOid,headRefOid,headRefName,isCrossRepository,mergeStateStatus,mergeable 2>/dev/null); then
      echo "FAIL: could not read PR #$PR metadata (base, head, branch) before waiting for CI" >&2
      exit 1
    fi
    PR_BASE_OID=$(node -e 'const d=JSON.parse(process.argv[1]);console.log(d.baseRefOid||"")' "$PR_META")
    PR_HEAD_OID=$(node -e 'const d=JSON.parse(process.argv[1]);console.log(d.headRefOid||"")' "$PR_META")
    PR_HEAD_BRANCH=$(node -e 'const d=JSON.parse(process.argv[1]);console.log(d.headRefName||"")' "$PR_META")
    PR_IS_FORK=$(node -e 'const d=JSON.parse(process.argv[1]);console.log(d.isCrossRepository===true?"true":"false")' "$PR_META")
    PR_MERGE_STATE=$(node -e 'const d=JSON.parse(process.argv[1]);console.log(d.mergeStateStatus||"")' "$PR_META")
    # baseRefOid tracks the live base tip on GitHub, so BEHIND is normally reported as DIRTY/CONFLICTING.
    PR_MERGEABLE=$(node -e 'const d=JSON.parse(process.argv[1]);console.log(d.mergeable||"")' "$PR_META")

    if ! MAIN_LINE=$(git ls-remote origin refs/heads/main 2>&1); then
      echo "FAIL: git ls-remote failed for origin refs/heads/main: $MAIN_LINE" >&2
      exit 1
    fi
    MAIN_SHA=$(echo "$MAIN_LINE" | awk '{print $1}')

    if [[ -n "$MAIN_SHA" && ( "$PR_BASE_OID" != "$MAIN_SHA" || "$PR_MERGE_STATE" == "BEHIND" || "$PR_MERGE_STATE" == "DIRTY" || "$PR_MERGEABLE" == "CONFLICTING" ) ]]; then
      echo "==> [when-green] PR #$PR base is behind origin/main (${MAIN_SHA:0:7}); rebase attempt $ATTEMPT/$REBASE_MAX..."
      if [[ "$PR_IS_FORK" == "true" ]]; then
        echo "FAIL: PR #$PR comes from a fork; rebase it on the contributor's branch instead (nothing pushed)" >&2
        exit 1
      fi
      if [[ -z "$PR_HEAD_BRANCH" || -z "$PR_HEAD_OID" ]]; then
        echo "FAIL: PR #$PR has no readable head branch/commit; cannot rebase it (nothing pushed)" >&2
        exit 1
      fi
      if ! git fetch origin main; then
        echo "FAIL: git fetch origin main failed; cannot rebase PR #$PR (nothing pushed)" >&2
        exit 1
      fi
      FETCHED_MAIN=$(git rev-parse FETCH_HEAD)
      # Keep only one temporary rebase workspace across retries.
      if [[ -n "$REBASE_WT" ]]; then git worktree remove --force "$REBASE_WT" >/dev/null 2>&1 || true; fi
      if [[ -n "$REBASE_REF" ]]; then git update-ref -d "$REBASE_REF" >/dev/null 2>&1 || true; fi
      if [[ -n "$REBASE_DIR" ]]; then rm -rf "$REBASE_DIR"; fi
      REBASE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pr-gate-rebase.XXXXXX")"
      REBASE_WT="$REBASE_DIR/wt"
      REBASE_REF="refs/pr-gate/rebase-$PR"
      if ! git fetch origin "+refs/heads/$PR_HEAD_BRANCH:$REBASE_REF"; then
        echo "FAIL: git fetch of $PR_HEAD_BRANCH failed; cannot rebase PR #$PR (nothing pushed)" >&2
        exit 1
      fi
      if ! git worktree add --detach "$REBASE_WT" "$REBASE_REF" >/dev/null; then
        echo "FAIL: could not create a temporary worktree to rebase PR #$PR (nothing pushed)" >&2
        exit 1
      fi
      # docs/lessons/INDEX.md is generated: a conflict in it alone is self-healing, any other
      # conflict aborts as before. PR_GATE_LESSONS_INDEX_SCRIPT is the selftest seam for the generator.
      LESSONS_INDEX_SCRIPT="${PR_GATE_LESSONS_INDEX_SCRIPT:-$ROOT/scripts/lessons-index.sh}"
      if ! git -C "$REBASE_WT" rebase "$FETCHED_MAIN"; then
        CONFLICTS=$(git -C "$REBASE_WT" diff --name-only --diff-filter=U || true)
        CONFLICT_LIST=$(printf '%s\n' "$CONFLICTS" | grep -v '^$' || true)
        CONFLICT_COUNT=$(printf '%s\n' "$CONFLICT_LIST" | wc -l | tr -d ' ')
        if [[ "$CONFLICT_COUNT" -eq 1 && "$CONFLICT_LIST" == "docs/lessons/INDEX.md" ]]; then
          echo "==> [when-green] Only docs/lessons/INDEX.md conflicts; regenerating it..."
          # Fail closed: a generator error, a stale index, or a failed continue aborts the rebase.
          if OPENSAND_LESSONS_DIR="$REBASE_WT/docs/lessons" bash "$LESSONS_INDEX_SCRIPT" >/dev/null 2>&1 \
             && OPENSAND_LESSONS_DIR="$REBASE_WT/docs/lessons" bash "$LESSONS_INDEX_SCRIPT" --check >/dev/null 2>&1; then
            git -C "$REBASE_WT" add -- docs/lessons/INDEX.md
            # Non-interactive: a plain rebase --continue opens the editor and hangs when there is no tty.
            if GIT_EDITOR=true git -C "$REBASE_WT" rebase --continue >/dev/null 2>&1; then
              echo "PASS: regenerated docs/lessons/INDEX.md and continued the rebase for PR #$PR."
            else
              git -C "$REBASE_WT" rebase --abort >/dev/null 2>&1 || true
              echo "FAIL: regenerating docs/lessons/INDEX.md did not let the rebase continue for PR #$PR; nothing pushed." >&2
              exit 1
            fi
          else
            git -C "$REBASE_WT" rebase --abort >/dev/null 2>&1 || true
            echo "FAIL: regenerated docs/lessons/INDEX.md is stale or could not be written for PR #$PR; nothing pushed." >&2
            echo "       Run 'bash scripts/lessons-index.sh' locally and resolve the rebase by hand." >&2
            exit 1
          fi
        else
          git -C "$REBASE_WT" rebase --abort >/dev/null 2>&1 || true
          echo "FAIL: rebasing PR #$PR onto origin/main conflicts; nothing pushed. Resolve these files by hand:" >&2
          if [[ -n "$CONFLICTS" ]]; then
            while IFS= read -r conflict_file; do
              [[ -n "$conflict_file" ]] || continue
              printf '  %s\n' "$conflict_file" >&2
            done <<< "$CONFLICTS"
          else
            echo "  (git reported no unmerged files; see the rebase output above)" >&2
          fi
          exit 1
        fi
      fi
      NEW_HEAD=$(git -C "$REBASE_WT" rev-parse HEAD)
      if ! git -C "$REBASE_WT" push --force-with-lease="refs/heads/$PR_HEAD_BRANCH:$PR_HEAD_OID" origin "HEAD:refs/heads/$PR_HEAD_BRANCH"; then
        echo "FAIL: force-with-lease push of $PR_HEAD_BRANCH failed (has someone else pushed?); nothing merged" >&2
        exit 1
      fi
      if ! PUSHED_LINE=$(git ls-remote origin "refs/heads/$PR_HEAD_BRANCH" 2>&1); then
        echo "FAIL: could not verify the rebased $PR_HEAD_BRANCH on origin: $PUSHED_LINE" >&2
        exit 1
      fi
      PUSHED_SHA=$(echo "$PUSHED_LINE" | awk '{print $1}')
      if [[ "$PUSHED_SHA" != "$NEW_HEAD" ]]; then
        echo "FAIL: after the rebase push, origin/$PR_HEAD_BRANCH is ${PUSHED_SHA:-missing}, expected $NEW_HEAD" >&2
        exit 1
      fi
      # Checks for the new SHA register from now, not from the old deadline at startup.
      reset_no_checks_window
      echo "PASS: rebased PR #$PR onto origin/main ($FETCHED_MAIN) and force-pushed $PR_HEAD_BRANCH (${PR_HEAD_OID:0:7} -> ${NEW_HEAD:0:7}); waiting for its new CI."
    fi

    wait_for_green

    # Main can move during the wait; leave only once the PR is no longer behind.
    if ! PR_META=$(gh pr view "$PR" --json baseRefOid,headRefOid,headRefName,isCrossRepository,mergeStateStatus,mergeable 2>/dev/null); then
      echo "FAIL: could not re-read PR #$PR metadata after waiting for CI" >&2
      exit 1
    fi
    PR_BASE_OID=$(node -e 'const d=JSON.parse(process.argv[1]);console.log(d.baseRefOid||"")' "$PR_META")
    PR_MERGE_STATE=$(node -e 'const d=JSON.parse(process.argv[1]);console.log(d.mergeStateStatus||"")' "$PR_META")
    # baseRefOid tracks the live base tip on GitHub, so BEHIND is normally reported as DIRTY/CONFLICTING.
    PR_MERGEABLE=$(node -e 'const d=JSON.parse(process.argv[1]);console.log(d.mergeable||"")' "$PR_META")
    if ! MAIN_LINE=$(git ls-remote origin refs/heads/main 2>&1); then
      echo "FAIL: git ls-remote failed for origin refs/heads/main: $MAIN_LINE" >&2
      exit 1
    fi
    MAIN_SHA=$(echo "$MAIN_LINE" | awk '{print $1}')
    if [[ -n "$MAIN_SHA" && ( "$PR_BASE_OID" != "$MAIN_SHA" || "$PR_MERGE_STATE" == "BEHIND" || "$PR_MERGE_STATE" == "DIRTY" || "$PR_MERGEABLE" == "CONFLICTING" ) ]]; then
      continue
    fi
    break
  done
fi

echo "==> [Check 1/5] Checking PR #$PR status and CI rollups..."
if ! PR_JSON=$(gh pr view "$PR" --json state,isDraft,mergeable,baseRefOid,headRefOid,statusCheckRollup,body,labels 2>&1); then
  echo "FAIL: gh pr view failed for PR #$PR: $PR_JSON" >&2
  exit 1
fi

IS_WORKTREE_DRAFT=$(node -e '
  try {
    const d = JSON.parse(process.argv[1]);
    const body = d.body || "";
    console.log((d.isDraft === true && (body.includes("scripts/worktree.sh save") || body.includes("worktree.sh save"))) ? "true" : "false");
  } catch { console.log("false"); }
' "$PR_JSON" 2>/dev/null || echo "false")

if [[ "$IS_WORKTREE_DRAFT" == "true" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY RUN: PR #$PR is a draft opened by worktree.sh; would run 'gh pr ready $PR'"
  else
    echo "PR #$PR is a draft opened by worktree.sh; running 'gh pr ready $PR' automatically..."
    if ! READY_ERR=$(gh pr ready "$PR" 2>&1); then
      echo "FAIL: failed to mark PR #$PR ready: $READY_ERR" >&2
      exit 1
    fi
  fi
  if ! PR_JSON=$(gh pr view "$PR" --json state,isDraft,mergeable,baseRefOid,headRefOid,statusCheckRollup,body,labels 2>&1); then
    echo "FAIL: gh pr view failed for PR #$PR: $PR_JSON" >&2
    exit 1
  fi
fi

CHECK1_STATUS=0
CHECK1_OUT=$(node -e '
const raw = process.argv[1];
const pr = process.argv[2];
const isWorktreeDraft = process.argv[3];
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

if (data.isDraft === true && isWorktreeDraft !== "true") {
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
' "$PR_JSON" "$PR" "$IS_WORKTREE_DRAFT" 2>&1) || CHECK1_STATUS=$?

if [[ "$CHECK1_STATUS" -ne 0 ]]; then
  echo "$CHECK1_OUT" >&2
  exit "$CHECK1_STATUS"
fi
echo "$CHECK1_OUT"

BASE_REF_OID=$(node -e 'console.log(JSON.parse(process.argv[1]).baseRefOid || "")' "$PR_JSON")

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
  echo "PR base is out of date: baseRefOid ($BASE_REF_OID) != origin/main ($REMOTE_MAIN_SHA); updating branch..."
  if UPDATE_ERR=$(gh pr update-branch "$PR" 2>&1); then
    echo "$UPDATE_ERR"
    echo "branch updated; CI re-running; re-run pr-gate when green"
    exit 3
  fi
  echo "FAIL: could not update PR #$PR branch: $UPDATE_ERR" >&2
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
const allowGithub = process.argv[5] === "1";
const prJsonRaw = process.argv[6];
const pr = process.argv[7];

let hasOwnerApprovedGithub = false;
try {
  const prData = JSON.parse(prJsonRaw || "{}");
  const labels = (prData.labels || []).map(l => (typeof l === "string" ? l : (l && l.name) || ""));
  hasOwnerApprovedGithub = labels.includes("owner-approved-github");
} catch {}

if (allowGithub && !hasOwnerApprovedGithub) {
  console.error("FAIL: --allow-github requires label owner-approved-github on PR #" + pr + " (owner approval required for .github changes)");
  process.exit(1);
}

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
    if (!allowGithub) {
      console.error("FAIL: forbidden file in diff: " + f + " (changes under .github/ are forbidden)");
      process.exit(1);
    } else {
      console.log("WARNING: --allow-github passed: allowing .github file in diff: " + f);
    }
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
' "$DIFF_NAMES" "$FULL_DIFF" "$ALLOW_LOCKFILE" "$ALLOW_BINARY" "$ALLOW_GITHUB" "$PR_JSON" "$PR" 2>&1) || CHECK3_STATUS=$?

if [[ "$CHECK3_STATUS" -ne 0 ]]; then
  echo "$CHECK3_OUT" >&2
  exit "$CHECK3_STATUS"
fi
echo "$CHECK3_OUT"

echo "==> [Review gate] Checking Rigel PASS label on PR #$PR..."
gh label create rigel-pass --color 0e8a16 --description "Rigel QA verified" 2>/dev/null || true
HAS_RIGEL_PASS=$(node -e '
const d = JSON.parse(process.argv[1] || "{}");
const labels = (d.labels || []).map(l => (typeof l === "string" ? l : (l && l.name) || ""));
console.log(labels.includes("rigel-pass") ? "1" : "0");
' "$PR_JSON" 2>/dev/null || echo 0)
if [[ "$HAS_RIGEL_PASS" -ne 1 && "$NO_REVIEW" -eq 0 ]]; then
  echo "FAIL: PR #$PR needs Rigel PASS (label rigel-pass)" >&2
  exit 1
fi
if [[ "$NO_REVIEW" -eq 1 ]]; then
  echo "WARNING: merging PR #$PR without Rigel PASS; reason: $NO_REVIEW_REASON"
else
  echo "PASS: PR #$PR carries the rigel-pass label"
fi

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
  printf "FAIL: checkpoint tag verification failed: expected %s, got '%s'\n" "$REMOTE_MAIN_SHA" "$TAG_REMOTE_SHA" >&2
  exit 1
fi
echo "PASS: checkpoint tag $TAG verified on origin pointing to $REMOTE_MAIN_SHA"

echo "==> [Check 5/5] Merging PR #$PR..."
MERGE_ARGS=("$PR" --merge)
if [[ "$NO_REVIEW" -eq 1 ]]; then
  MERGE_ARGS+=(--body "Review waiver: $NO_REVIEW_REASON")
fi
if ! gh pr merge "${MERGE_ARGS[@]}"; then
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

if [[ "$POST_MERGE_CHECK" -eq 1 ]]; then
  post_merge_check "$MERGE_COMMIT"
fi
