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
        if [ "$is_merge_view" -eq 1 ]; then
          if [ -f "$TEST_CASE_DIR/pr_merge_view.json" ]; then
            cat "$TEST_CASE_DIR/pr_merge_view.json"
          else
            echo '{"mergeCommit":{"oid":"f8cb8862e31cc85ca91373b99bc58aa5b6a176e6"},"state":"MERGED"}'
          fi
          exit 0
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

case "$1" in
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

exit "$FAILED"
