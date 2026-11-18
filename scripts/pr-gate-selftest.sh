#!/usr/bin/env bash
# Selftest for scripts/pr-gate.sh using stubbed gh and git on PATH (no network).
# Covers:
# 1. all green -> merges
# 2. pending CI -> exit 3
# 3. a failed job -> non-zero with no tag and no merge
# 4. lockfile in diff -> fail
# 5. png in diff -> fail
# 6. --allow-binary -> passes with a warning
# 7. stale base -> fail
# 8. tag push fails -> no merge
# 11. --when-green: pending CI turns green during the watch -> normal checks run and merge
# 12. --when-green: CI goes red -> exit 1 naming the failing job, no tag, no merge
# 13. --when-green: watch outlives --timeout -> exit 3, watcher killed, no merge
# 14. without --when-green, gh pr checks is never called
# 15. --timeout validation
# 16. --when-green: CI has not registered any check yet -> waits for it, then watches and merges
# 17. --when-green: no check ever appears -> exit 3 naming "no CI checks", no merge
# 18. a draft PR is refused before any checkpoint tag or merge, naming `gh pr ready`
# 19. --when-green: gh pr checks says "no checks reported" twice, then green -> merges
# 20. --when-green: gh pr checks never reports any check -> bounded exit 3 naming "no CI checks appeared after Ns"
# Usage: scripts/pr-gate-selftest.sh (PR_GATE_SCRIPT=<path> to test another copy)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR_GATE="${PR_GATE_SCRIPT:-$ROOT/scripts/pr-gate.sh}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/opensand-pr-gate-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAILED=0

BIN_DIR="$WORK/bin"
mkdir -p "$BIN_DIR"

# Stubbed gh (no shebang to avoid macOS Endpoint Security AUTH_EXEC trap, AGENTS_LEARNING 12.27)
cat << 'EOS' > "$BIN_DIR/gh"
if [ -z "${TEST_CASE_DIR:-}" ]; then
  echo "gh stub error: TEST_CASE_DIR not set" >&2
  exit 1
fi

case "$1" in
  pr)
    case "$2" in
      view)
        is_merge_view=0
        for arg in "$@"; do
          if [ "$arg" = "mergeCommit,state" ] || [ "$arg" = "state,mergeCommit" ]; then
            is_merge_view=1
          fi
        done
        is_rebase_meta=0
        for arg in "$@"; do
          case "$arg" in
            *mergeStateStatus*) is_rebase_meta=1 ;;
          esac
        done
        if [ "$is_rebase_meta" -eq 1 ]; then
          if [ -f "$TEST_CASE_DIR/behind_times" ]; then
            n=$(cat "$TEST_CASE_DIR/behind_times")
            if [ "$n" -gt 0 ]; then
              echo $((n - 1)) > "$TEST_CASE_DIR/behind_times"
              cat "$TEST_CASE_DIR/pr_rebase_meta_behind.json" 2>/dev/null || echo '{"baseRefOid":"9999999999999999999999999999999999999999","headRefOid":"2222222222222222222222222222222222222222","headRefName":"job/test","isCrossRepository":false,"mergeStateStatus":"BEHIND"}'
              exit 0
            fi
          fi
          cat "$TEST_CASE_DIR/pr_rebase_meta_clean.json" 2>/dev/null || echo '{"baseRefOid":"1111111111111111111111111111111111111111","headRefOid":"3333333333333333333333333333333333333333","headRefName":"job/test","isCrossRepository":false,"mergeStateStatus":"CLEAN"}'
          exit 0
        fi
        if [ "$is_merge_view" -eq 1 ]; then
          if [ -f "$TEST_CASE_DIR/pr_merge_view.json" ]; then
            cat "$TEST_CASE_DIR/pr_merge_view.json"
          else
            echo '{"mergeCommit":{"oid":"f8cb8862e31cc85ca91373b99bc58aa5b6a176e6"},"state":"MERGED"}'
          fi
          exit 0
        fi
        # pr_view_late.json replaces pr_view.json after the first $(cat late_after) views: CI that
        # registers its checks a few seconds after the PR was opened
        if [ -f "$TEST_CASE_DIR/pr_view_late.json" ]; then
          echo x >> "$TEST_CASE_DIR/view_count"
          if [ "$(wc -l < "$TEST_CASE_DIR/view_count")" -gt "$(cat "$TEST_CASE_DIR/late_after")" ]; then
            cp "$TEST_CASE_DIR/pr_view_late.json" "$TEST_CASE_DIR/pr_view.json"
          fi
        fi
        if [ -f "$TEST_CASE_DIR/pr_view.json" ]; then
          cat "$TEST_CASE_DIR/pr_view.json"
          exit 0
        fi
        echo "gh pr view: mock data missing in $TEST_CASE_DIR" >&2
        exit 1
        ;;
      diff)
        is_name_only=0
        for arg in "$@"; do
          if [ "$arg" = "--name-only" ]; then
            is_name_only=1
          fi
        done
        if [ "$is_name_only" -eq 1 ]; then
          if [ -f "$TEST_CASE_DIR/pr_diff_names" ]; then
            cat "$TEST_CASE_DIR/pr_diff_names"
          fi
          exit 0
        else
          if [ -f "$TEST_CASE_DIR/pr_diff_full" ]; then
            cat "$TEST_CASE_DIR/pr_diff_full"
          fi
          exit 0
        fi
        ;;
      checks)
        echo "gh pr checks $*" >> "$TEST_CASE_DIR/checks_calls.log"
        # checks_no_reported_times=N: the first N calls report "no checks reported" (CI not
        # registered yet) and exit 1, as the real gh does; later calls behave normally.
        if [ -f "$TEST_CASE_DIR/checks_no_reported_times" ]; then
          seen_calls=$(wc -l < "$TEST_CASE_DIR/checks_calls.log" | tr -d ' ')
          if [ "$seen_calls" -le "$(cat "$TEST_CASE_DIR/checks_no_reported_times")" ]; then
            echo "no checks reported on the 'job/x' branch" >&2
            exit 1
          fi
        fi
        if [ -f "$TEST_CASE_DIR/checks_hang" ]; then
          exec sleep 30
        fi
        if [ -f "$TEST_CASE_DIR/pr_view_after_watch.json" ]; then
          cp "$TEST_CASE_DIR/pr_view_after_watch.json" "$TEST_CASE_DIR/pr_view.json"
        fi
        if [ -f "$TEST_CASE_DIR/checks_exit" ]; then
          exit "$(cat "$TEST_CASE_DIR/checks_exit")"
        fi
        exit 0
        ;;
      merge)
        echo "gh pr merge $*" >> "$TEST_CASE_DIR/merge_calls.log"
        if [ -f "$TEST_CASE_DIR/fail_merge" ]; then
          echo "gh pr merge failed" >&2
          exit 1
        fi
        exit 0
        ;;
      *)
        echo "gh stub: unhandled pr subcmd $2" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "gh stub: unhandled command $1" >&2
    exit 1
    ;;
esac
EOS
chmod +x "$BIN_DIR/gh"

# Stubbed git (no shebang, AGENTS_LEARNING 12.27)
cat << 'EOS' > "$BIN_DIR/git"
if [ -z "${TEST_CASE_DIR:-}" ]; then
  echo "git stub error: TEST_CASE_DIR not set" >&2
  exit 1
fi

case "${1:-}" in
  -C)
    # git -C <path> ...: the gate only uses this inside its temporary rebase worktree.
    shift 2
    case "${1:-}" in
      rebase)
        if [ "${2:-}" = "--abort" ]; then
          exit 0
        fi
        if [ -f "$TEST_CASE_DIR/rebase_conflict" ]; then
          echo "CONFLICT (content): merge conflict" >&2
          exit 1
        fi
        exit 0
        ;;
      rev-parse)
        if [ -f "$TEST_CASE_DIR/rebased_head_sha" ]; then
          cat "$TEST_CASE_DIR/rebased_head_sha"
        else
          echo "3333333333333333333333333333333333333333"
        fi
        exit 0
        ;;
      diff)
        # unmerged files after a conflicting rebase
        if [ -f "$TEST_CASE_DIR/rebase_conflict" ] && [ -f "$TEST_CASE_DIR/conflict_files" ]; then
          cat "$TEST_CASE_DIR/conflict_files"
        fi
        exit 0
        ;;
      push)
        echo "git -C <wt> push $*" >> "$TEST_CASE_DIR/force_push.log"
        if [ -f "$TEST_CASE_DIR/fail_force_push" ]; then
          echo " ! [rejected] (stale info)" >&2
          exit 1
        fi
        if [ -f "$TEST_CASE_DIR/base_becomes_current" ]; then
          /usr/bin/perl -pi -e 's/"baseRefOid":\s*"[^"]+"/"baseRefOid": "1111111111111111111111111111111111111111"/' "$TEST_CASE_DIR/pr_view.json"
        fi
        exit 0
        ;;
      *)
        echo "git stub: unhandled -C subcmd ${1:-}" >&2
        exit 1
        ;;
    esac
    ;;
  fetch)
    echo "git fetch $*" >> "$TEST_CASE_DIR/git_fetch.log"
    exit 0
    ;;
  worktree)
    case "${2:-}" in
      add)
        # worktree add --detach <path> <ref>
        shift 3
        mkdir -p "$1"
        printf '%s\n' "${2:-}" > "$TEST_CASE_DIR/worktree_ref"
        exit 0
        ;;
      remove)
        # worktree remove --force <path>
        for wt_arg in "$@"; do wt_path="$wt_arg"; done
        rm -rf "$wt_path"
        exit 0
        ;;
      *)
        echo "git stub: unhandled worktree subcmd ${2:-}" >&2
        exit 1
        ;;
    esac
    ;;
  update-ref)
    exit 0
    ;;
  ls-remote)
    for arg in "$@"; do
      if [ "$arg" = "refs/heads/main" ]; then
        sha="1111111111111111111111111111111111111111"
        if [ -f "$TEST_CASE_DIR/remote_main_sha" ]; then
          sha=$(cat "$TEST_CASE_DIR/remote_main_sha")
        fi
        printf "%s\trefs/heads/main\n" "$sha"
        exit 0
      fi
    done

    # A job branch (post-rebase push verification)
    for arg in "$@"; do
      case "$arg" in
        refs/heads/*)
          sha="3333333333333333333333333333333333333333"
          if [ -f "$TEST_CASE_DIR/rebased_head_sha" ]; then
            sha=$(cat "$TEST_CASE_DIR/rebased_head_sha")
          fi
          printf "%s\t%s\n" "$sha" "$arg"
          exit 0
          ;;
      esac
    done

    # Tag ls-remote check
    echo "git ls-remote $*" >> "$TEST_CASE_DIR/git_ls_remote.log"
    if [ -f "$TEST_CASE_DIR/fail_tag_verify" ]; then
      exit 1
    fi
    sha="1111111111111111111111111111111111111111"
    if [ -f "$TEST_CASE_DIR/tag_ls_remote_sha" ]; then
      sha=$(cat "$TEST_CASE_DIR/tag_ls_remote_sha")
    elif [ -f "$TEST_CASE_DIR/remote_main_sha" ]; then
      sha=$(cat "$TEST_CASE_DIR/remote_main_sha")
    fi
    if [ -z "$sha" ]; then
      exit 0
    fi
    tag=""
    for arg in "$@"; do tag="$arg"; done
    printf "%s\trefs/tags/%s\n" "$sha" "$tag"
    exit 0
    ;;
  tag)
    echo "git tag $*" >> "$TEST_CASE_DIR/git_tag.log"
    exit 0
    ;;
  push)
    echo "git push $*" >> "$TEST_CASE_DIR/git_push.log"
    if [ -f "$TEST_CASE_DIR/fail_tag_push" ]; then
      echo "error: failed to push some refs to 'origin'" >&2
      exit 1
    fi
    exit 0
    ;;
  rev-parse)
    if [ "${2:-}" = "FETCH_HEAD" ]; then
      if [ -f "$TEST_CASE_DIR/remote_main_sha" ]; then
        cat "$TEST_CASE_DIR/remote_main_sha"
      else
        echo "1111111111111111111111111111111111111111"
      fi
      exit 0
    fi
    echo "$TEST_CASE_DIR"
    exit 0
    ;;
  *)
    /usr/bin/git "$@"
    ;;
esac
EOS
chmod +x "$BIN_DIR/git"

setup_defaults() {
  local dir="$1"
  mkdir -p "$dir"
  echo "1111111111111111111111111111111111111111" > "$dir/remote_main_sha"
  cat << 'JSON' > "$dir/pr_view.json"
{
  "state": "OPEN",
  "mergeable": "MERGEABLE",
  "baseRefOid": "1111111111111111111111111111111111111111",
  "headRefOid": "2222222222222222222222222222222222222222",
  "statusCheckRollup": [
    {
      "name": "Build & test (Node 22)",
      "status": "COMPLETED",
      "conclusion": "SUCCESS"
    },
    {
      "name": "Build & test (macOS, Node 22)",
      "status": "COMPLETED",
      "conclusion": "SUCCESS"
    }
  ]
}
JSON
  cat << 'NAMES' > "$dir/pr_diff_names"
packages/desktop/src/main.ts
scripts/verify.sh
NAMES
  cat << 'DIFF' > "$dir/pr_diff_full"
diff --git a/scripts/verify.sh b/scripts/verify.sh
--- a/scripts/verify.sh
+++ b/scripts/verify.sh
@@ -1 +1 @@
-old
+new
DIFF
}

# run_test_case <label> <flags...> <pr-number>
# env overrides: EXPECT_EXIT, EXPECT_MERGE, EXPECT_TAG, NEED_SUBSTRINGS
run_test_case() {
  local label="$1"
  shift
  local dir="$WORK/$label"

  local out status ok=1
  out=$(PATH="$BIN_DIR:$PATH" TEST_CASE_DIR="$dir" bash "$PR_GATE" "$@" 2>&1 < /dev/null) || status=$?
  status="${status:-0}"

  if [[ "$status" -ne "$EXPECT_EXIT" ]]; then
    echo "FAIL $label: exit $status, wanted $EXPECT_EXIT"
    ok=0
  fi

  for needle in "${NEED_SUBSTRINGS[@]}"; do
    if ! grep -qF -- "$needle" <<< "$out"; then
      echo "FAIL $label: missing required substring '$needle'"
      ok=0
    fi
  done

  if [[ "${EXPECT_MERGE:-0}" -eq 1 ]]; then
    if [[ ! -f "$dir/merge_calls.log" ]]; then
      echo "FAIL $label: expected gh pr merge to be called, but merge_calls.log is missing"
      ok=0
    fi
  else
    if [[ -f "$dir/merge_calls.log" ]]; then
      echo "FAIL $label: gh pr merge was called, but should NOT have been"
      ok=0
    fi
  fi

  if [[ "${EXPECT_TAG:-0}" -eq 1 ]]; then
    if [[ ! -f "$dir/git_push.log" ]]; then
      echo "FAIL $label: expected git push tag to be called, but git_push.log is missing"
      ok=0
    fi
  else
    if [[ -f "$dir/git_push.log" ]]; then
      echo "FAIL $label: git push tag was called, but should NOT have been"
      ok=0
    fi
  fi

  if [[ "$ok" -eq 1 ]]; then
    echo "PASS $label (exit $status)"
  else
    echo "$out" | sed 's/^/    | /'
    FAILED=1
  fi
}

# --- Case 1: All green -> merges ---
dir="$WORK/case1-all-green"
setup_defaults "$dir"
EXPECT_EXIT=0
EXPECT_MERGE=1
EXPECT_TAG=1
NEED_SUBSTRINGS=("PASS: PR" "OPEN" "MERGEABLE" "PASS: PR base is up to date" "PASS: no forbidden files" "checkpoint/" "Merge commit: f8cb8862e31cc85ca91373b99bc58aa5b6a176e6")
run_test_case "case1-all-green" 42

# --- Case 2: Pending CI -> exit 3 ---
dir="$WORK/case2-pending-ci"
setup_defaults "$dir"
cat << 'JSON' > "$dir/pr_view.json"
{
  "state": "OPEN",
  "mergeable": "MERGEABLE",
  "baseRefOid": "1111111111111111111111111111111111111111",
  "headRefOid": "2222222222222222222222222222222222222222",
  "statusCheckRollup": [
    {
      "name": "Build & test (Node 22)",
      "status": "COMPLETED",
      "conclusion": "SUCCESS"
    },
    {
      "name": "Build & test (macOS, Node 22)",
      "status": "IN_PROGRESS",
      "conclusion": null
    }
  ]
}
JSON
EXPECT_EXIT=3
EXPECT_MERGE=0
EXPECT_TAG=0
NEED_SUBSTRINGS=("FAIL: CI job for macOS" "is not completed")
run_test_case "case2-pending-ci" 42

# --- Case 3: Failed job -> non-zero with no tag and no merge ---
dir="$WORK/case3-failed-job"
setup_defaults "$dir"
cat << 'JSON' > "$dir/pr_view.json"
{
  "state": "OPEN",
  "mergeable": "MERGEABLE",
  "baseRefOid": "1111111111111111111111111111111111111111",
  "headRefOid": "2222222222222222222222222222222222222222",
  "statusCheckRollup": [
    {
      "name": "Build & test (Node 22)",
      "status": "COMPLETED",
      "conclusion": "FAILURE"
    },
    {
      "name": "Build & test (macOS, Node 22)",
      "status": "COMPLETED",
      "conclusion": "SUCCESS"
    }
  ]
}
JSON
EXPECT_EXIT=1
EXPECT_MERGE=0
EXPECT_TAG=0
NEED_SUBSTRINGS=("FAIL: CI job for Linux" "failed with conclusion: FAILURE")
run_test_case "case3-failed-job" 42

# --- Case 4: Lockfile in diff -> fail ---
dir="$WORK/case4-lockfile-diff"
setup_defaults "$dir"
cat << 'NAMES' > "$dir/pr_diff_names"
packages/desktop/src/main.ts
pnpm-lock.yaml
NAMES
EXPECT_EXIT=1
EXPECT_MERGE=0
EXPECT_TAG=0
NEED_SUBSTRINGS=("FAIL: forbidden file in diff: pnpm-lock.yaml" "--allow-lockfile")
run_test_case "case4-lockfile-diff" 42

# --- Case 5: PNG in diff -> fail ---
dir="$WORK/case5-png-diff"
setup_defaults "$dir"
cat << 'NAMES' > "$dir/pr_diff_names"
packages/desktop/src/main.ts
docs/screenshot.png
NAMES
EXPECT_EXIT=1
EXPECT_MERGE=0
EXPECT_TAG=0
NEED_SUBSTRINGS=("FAIL: forbidden binary file in diff: docs/screenshot.png" "--allow-binary")
run_test_case "case5-png-diff" 42

# --- Case 6: --allow-binary -> passes with a warning ---
dir="$WORK/case6-allow-binary"
setup_defaults "$dir"
cat << 'NAMES' > "$dir/pr_diff_names"
packages/desktop/src/main.ts
docs/screenshot.png
NAMES
EXPECT_EXIT=0
EXPECT_MERGE=1
EXPECT_TAG=1
NEED_SUBSTRINGS=("WARNING: --allow-binary passed" "allowing binary file in diff: docs/screenshot.png" "Merge commit: f8cb8862e31cc85ca91373b99bc58aa5b6a176e6")
run_test_case "case6-allow-binary" --allow-binary 42

# --- Case 7: Stale base -> fail ---
dir="$WORK/case7-stale-base"
setup_defaults "$dir"
echo "9999999999999999999999999999999999999999" > "$dir/remote_main_sha"
EXPECT_EXIT=1
EXPECT_MERGE=0
EXPECT_TAG=0
NEED_SUBSTRINGS=("FAIL: PR base is out of date" "1111111111111111111111111111111111111111" "9999999999999999999999999999999999999999")
run_test_case "case7-stale-base" 42

# --- Case 8: Tag push fails -> no merge ---
dir="$WORK/case8-tag-push-fails"
setup_defaults "$dir"
touch "$dir/fail_tag_push"
EXPECT_EXIT=1
EXPECT_MERGE=0
EXPECT_TAG=1
NEED_SUBSTRINGS=("FAIL: failed to push checkpoint tag")
run_test_case "case8-tag-push-fails" 42

# --- Case 9 (Bonus verification): Tag remote verification fails -> no merge ---
dir="$WORK/case9-tag-verify-fails"
setup_defaults "$dir"
echo "mismatch_sha_000000000000000000000000000" > "$dir/tag_ls_remote_sha"
EXPECT_EXIT=1
EXPECT_MERGE=0
EXPECT_TAG=1
NEED_SUBSTRINGS=("FAIL: checkpoint tag verification failed")
run_test_case "case9-tag-verify-fails" 42

# --- Case 10 (Bonus verification): Dry run -> no tag, no merge ---
dir="$WORK/case10-dry-run"
setup_defaults "$dir"
EXPECT_EXIT=0
EXPECT_MERGE=0
EXPECT_TAG=0
NEED_SUBSTRINGS=("DRY RUN: all pre-merge checks passed" "would create and push tag" "would merge PR #42")
run_test_case "case10-dry-run" --dry-run 42

# --- Case 11: --when-green, CI pending then green after the watch -> merges ---
dir="$WORK/case11-when-green-pending-then-green"
setup_defaults "$dir"
cp "$dir/pr_view.json" "$dir/pr_view_after_watch.json"
cat << 'JSON' > "$dir/pr_view.json"
{
  "state": "OPEN",
  "mergeable": "MERGEABLE",
  "baseRefOid": "1111111111111111111111111111111111111111",
  "headRefOid": "2222222222222222222222222222222222222222",
  "statusCheckRollup": [
    {"name": "Build & test (Node 22)", "status": "IN_PROGRESS", "conclusion": null},
    {"name": "Build & test (macOS, Node 22)", "status": "IN_PROGRESS", "conclusion": null}
  ]
}
JSON
EXPECT_EXIT=0
EXPECT_MERGE=1
EXPECT_TAG=1
NEED_SUBSTRINGS=("[when-green] Watching CI for PR #42" "CI finished green" "PASS: PR #42 is OPEN" "Merge commit: f8cb8862e31cc85ca91373b99bc58aa5b6a176e6")
run_test_case "case11-when-green-pending-then-green" --when-green 42
grep -q -- "--watch" "$dir/checks_calls.log" 2>/dev/null || { echo "FAIL case11: gh pr checks --watch was not called"; FAILED=1; }

# --- Case 12: --when-green, CI red -> exit 1, names the failing job, no tag, no merge ---
dir="$WORK/case12-when-green-red"
setup_defaults "$dir"
echo 1 > "$dir/checks_exit"
cat << 'JSON' > "$dir/pr_view.json"
{
  "state": "OPEN",
  "mergeable": "MERGEABLE",
  "baseRefOid": "1111111111111111111111111111111111111111",
  "headRefOid": "2222222222222222222222222222222222222222",
  "statusCheckRollup": [
    {"name": "Build & test (Node 22)", "status": "COMPLETED", "conclusion": "SUCCESS"},
    {"name": "Build & test (macOS, Node 22)", "status": "COMPLETED", "conclusion": "FAILURE"}
  ]
}
JSON
EXPECT_EXIT=1
EXPECT_MERGE=0
EXPECT_TAG=0
NEED_SUBSTRINGS=("FAIL: CI is red for PR #42" "Build & test (macOS, Node 22) (FAILURE)")
run_test_case "case12-when-green-red" --when-green 42

# --- Case 13: --when-green, watch outlives --timeout -> exit 3, no merge, watcher killed ---
dir="$WORK/case13-when-green-timeout"
setup_defaults "$dir"
touch "$dir/checks_hang"
EXPECT_EXIT=3
EXPECT_MERGE=0
EXPECT_TAG=0
NEED_SUBSTRINGS=("--when-green timed out after 1 min" "still pending")
start=$SECONDS
PR_GATE_TIMEOUT_UNIT_SECONDS=2 run_test_case "case13-when-green-timeout" --when-green --timeout 1 42
elapsed=$((SECONDS - start))
if [[ "$elapsed" -gt 10 ]]; then
  echo "FAIL case13: timeout took ${elapsed}s, expected about 2s (watcher not bounded)"
  FAILED=1
fi

# --- Case 16: --when-green right after the PR was opened: no checks yet, they appear later ---
dir="$WORK/case16-when-green-checks-appear"
setup_defaults "$dir"
cp "$dir/pr_view.json" "$dir/pr_view_late.json"
echo 2 > "$dir/late_after"
cat << 'JSON' > "$dir/pr_view.json"
{
  "state": "OPEN",
  "mergeable": "MERGEABLE",
  "baseRefOid": "1111111111111111111111111111111111111111",
  "headRefOid": "2222222222222222222222222222222222222222",
  "statusCheckRollup": []
}
JSON
EXPECT_EXIT=0
EXPECT_MERGE=1
EXPECT_TAG=1
NEED_SUBSTRINGS=("[when-green] Watching CI for PR #42" "CI finished green" "Merge commit: f8cb8862e31cc85ca91373b99bc58aa5b6a176e6")
PR_GATE_POLL_SECONDS=1 run_test_case "case16-when-green-checks-appear" --when-green 42
grep -q -- "--watch" "$dir/checks_calls.log" 2>/dev/null || { echo "FAIL case16: gh pr checks --watch was not called once checks appeared"; FAILED=1; }
if [[ "$(wc -l < "$dir/view_count" 2>/dev/null || echo 0)" -lt 3 ]]; then
  echo "FAIL case16: the gate did not poll until the checks appeared"
  FAILED=1
fi

# --- Case 17: --when-green and no check ever appears -> exit 3, no merge, no watch ---
dir="$WORK/case17-when-green-no-checks"
setup_defaults "$dir"
cat << 'JSON' > "$dir/pr_view.json"
{
  "state": "OPEN",
  "mergeable": "MERGEABLE",
  "baseRefOid": "1111111111111111111111111111111111111111",
  "headRefOid": "2222222222222222222222222222222222222222",
  "statusCheckRollup": []
}
JSON
EXPECT_EXIT=3
EXPECT_MERGE=0
EXPECT_TAG=0
NEED_SUBSTRINGS=("FAIL: no CI checks appeared after" "for PR #42")
start=$SECONDS
PR_GATE_POLL_SECONDS=1 PR_GATE_TIMEOUT_UNIT_SECONDS=2 run_test_case "case17-when-green-no-checks" --when-green --timeout 1 42
elapsed=$((SECONDS - start))
if [[ "$elapsed" -gt 10 ]]; then
  echo "FAIL case17: gave up after ${elapsed}s, expected about 2s"
  FAILED=1
fi
if [[ -f "$dir/checks_calls.log" ]]; then
  echo "FAIL case17: gh pr checks was called although no check ever appeared"
  FAILED=1
fi

# --- Case 19: --when-green, gh pr checks reports "no checks reported" twice, then green -> merges ---
dir="$WORK/case19-when-green-no-checks-reported-then-green"
setup_defaults "$dir"
echo 2 > "$dir/checks_no_reported_times"
EXPECT_EXIT=0
EXPECT_MERGE=1
EXPECT_TAG=1
NEED_SUBSTRINGS=("[when-green] Watching CI for PR #42" "CI finished green" "Merge commit: f8cb8862e31cc85ca91373b99bc58aa5b6a176e6")
PR_GATE_POLL_SECONDS=1 run_test_case "case19-when-green-no-checks-reported-then-green" --when-green 42
if [[ "$(wc -l < "$dir/checks_calls.log" 2>/dev/null || echo 0)" -lt 3 ]]; then
  echo "FAIL case19: expected at least 3 gh pr checks calls (2 pending + 1 green), got $(wc -l < "$dir/checks_calls.log" 2>/dev/null || echo 0)"
  FAILED=1
fi

# --- Case 20: --when-green, gh pr checks never reports a check -> bounded exit 3, no merge ---
dir="$WORK/case20-when-green-no-checks-ever-reported"
setup_defaults "$dir"
echo 9999 > "$dir/checks_no_reported_times"
EXPECT_EXIT=3
EXPECT_MERGE=0
EXPECT_TAG=0
NEED_SUBSTRINGS=("FAIL: no CI checks appeared after" "for PR #42")
start=$SECONDS
PR_GATE_POLL_SECONDS=1 PR_GATE_NO_CHECKS_GRACE_SECONDS=2 run_test_case "case20-when-green-no-checks-ever-reported" --when-green --timeout 1 42
elapsed=$((SECONDS - start))
if [[ "$elapsed" -gt 10 ]]; then
  echo "FAIL case20: gave up after ${elapsed}s, expected about 2s"
  FAILED=1
fi

# --- Case 18: a draft PR (opened by worktree.sh save) -> exit 1 before the tag, no merge ---
dir="$WORK/case18-draft"
setup_defaults "$dir"
cat << 'JSON' > "$dir/pr_view.json"
{
  "state": "OPEN",
  "isDraft": true,
  "mergeable": "MERGEABLE",
  "baseRefOid": "1111111111111111111111111111111111111111",
  "headRefOid": "2222222222222222222222222222222222222222",
  "statusCheckRollup": [
    {"name": "Build & test (Node 22)", "status": "COMPLETED", "conclusion": "SUCCESS"},
    {"name": "Build & test (macOS, Node 22)", "status": "COMPLETED", "conclusion": "SUCCESS"}
  ]
}
JSON
EXPECT_EXIT=1
EXPECT_MERGE=0
EXPECT_TAG=0
NEED_SUBSTRINGS=("is still a draft" "gh pr ready 42")
run_test_case "case18-draft" 42

# --- Case 14: without --when-green, gh pr checks is never called ---
if [[ -f "$WORK/case1-all-green/checks_calls.log" || -f "$WORK/case2-pending-ci/checks_calls.log" ]]; then
  echo "FAIL case14: gh pr checks called without --when-green"
  FAILED=1
else
  echo "PASS case14 (no gh pr checks call without --when-green)"
fi

# --- Case 15: --timeout validation ---
dir="$WORK/case15-bad-timeout"
setup_defaults "$dir"
EXPECT_EXIT=1
EXPECT_MERGE=0
EXPECT_TAG=0
NEED_SUBSTRINGS=("FAIL: --timeout needs a positive whole number of minutes")
run_test_case "case15-bad-timeout" --when-green --timeout abc 42


# --- Case 21: --when-green, PR behind main -> clean rebase, force-push, wait for new CI, merge ---
dir="$WORK/case21-behind-rebase-merge"
setup_defaults "$dir"
echo 2 > "$dir/behind_times"
touch "$dir/base_becomes_current"
/usr/bin/perl -pi -e 's/"baseRefOid":\s*"[^"]+"/"baseRefOid": "9999999999999999999999999999999999999999"/' "$dir/pr_view.json"
EXPECT_EXIT=0
EXPECT_MERGE=1
EXPECT_TAG=1
NEED_SUBSTRINGS=("base is behind origin/main" "rebase attempt 1/3" "rebased PR #42" "force-pushed job/test" "CI finished green" "Merge commit: f8cb8862e31cc85ca91373b99bc58aa5b6a176e6")
run_test_case "case21-behind-rebase-merge" --when-green 42
if [[ ! -f "$dir/force_push.log" ]]; then
  echo "FAIL case21: no force-with-lease push happened"
  FAILED=1
elif ! grep -q -- "--force-with-lease=refs/heads/job/test:2222222222222222222222222222222222222222" "$dir/force_push.log"; then
  echo "FAIL case21: push did not use a force-with-lease on the PR branch only"
  FAILED=1
fi
if [[ "$(grep -c 'fetch origin main' "$dir/git_fetch.log" 2>/dev/null || echo 0)" -ne 1 ]]; then
  echo "FAIL case21: expected exactly one rebase onto origin/main"
  FAILED=1
fi

# --- Case 22: --when-green, rebase conflict -> abort, name files, no push and no merge ---
dir="$WORK/case22-rebase-conflict"
setup_defaults "$dir"
echo 1 > "$dir/behind_times"
touch "$dir/rebase_conflict"
printf 'src/a.ts\nsrc/b.ts\n' > "$dir/conflict_files"
EXPECT_EXIT=1
EXPECT_MERGE=0
EXPECT_TAG=0
NEED_SUBSTRINGS=("rebasing PR #42 onto origin/main conflicts" "nothing pushed" "src/a.ts" "src/b.ts")
run_test_case "case22-rebase-conflict" --when-green 42
if [[ -f "$dir/force_push.log" ]]; then
  echo "FAIL case22: a conflicting rebase must not push anything"
  FAILED=1
fi

# --- Case 23: --when-green, main keeps moving -> rebase retried at most 3 times ---
dir="$WORK/case23-retry-cap"
setup_defaults "$dir"
echo 99 > "$dir/behind_times"
EXPECT_EXIT=1
EXPECT_MERGE=0
EXPECT_TAG=0
NEED_SUBSTRINGS=("rebase attempt 1/3" "rebase attempt 2/3" "rebase attempt 3/3" "still behind origin/main after 3 rebase attempts")
run_test_case "case23-retry-cap" --when-green 42
if [[ "$(grep -c 'fetch origin main' "$dir/git_fetch.log" 2>/dev/null || echo 0)" -ne 3 ]]; then
  echo "FAIL case23: expected exactly 3 rebase attempts, got $(grep -c 'fetch origin main' "$dir/git_fetch.log" 2>/dev/null || echo 0)"
  FAILED=1
fi
exit "$FAILED"
