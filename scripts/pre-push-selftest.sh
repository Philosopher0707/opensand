#!/usr/bin/env bash
# Hermetic selftest for scripts/pre-push.sh and the CI event-scoped gitleaks commands.
# The planted value is assembled at runtime and must never appear in test output.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GITLEAKS_BIN="${GITLEAKS_BIN:-gitleaks}"

# A hook may export GIT_* into its children. Keep this fixture out of the real repo.
while IFS='=' read -r name _; do
  case "$name" in
    GIT_*) unset "$name" ;;
  esac
done < <(env)
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1

if [[ ! -x "$ROOT/scripts/pre-push.sh" ]]; then
  echo "FAIL: scripts/pre-push.sh is missing or not executable"
  exit 1
fi

if ! version=$("$GITLEAKS_BIN" version 2>/dev/null); then
  echo "FAIL: gitleaks is unavailable; set GITLEAKS_BIN to the pinned 8.30.1 binary"
  exit 2
fi
if [[ "$version" != "8.30.1" ]]; then
  echo "FAIL: gitleaks 8.30.1 is required; found '$version'"
  exit 2
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/opensand-prepush-selftest.XXXXXX")
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

FAILED=0
ZERO=$(printf '0%.0s' {1..40})
FAKE_KEY="ghp_$(printf 'opensand-selftest-not-a-real-token' | shasum -a 256 | cut -c1-36)"

new_repo() {
  local dir
  dir=$(mktemp -d "$WORK/repo.XXXXXX")
  mkdir -p "$dir/scripts"
  cp "$ROOT/scripts/pre-push.sh" "$dir/scripts/pre-push.sh"
  cp "$ROOT/.gitleaks.toml" "$dir/.gitleaks.toml"
  git -C "$dir" init -q
  git -C "$dir" symbolic-ref HEAD refs/heads/main
  git -C "$dir" config user.email selftest@example.invalid
  git -C "$dir" config user.name "Pre-push Selftest"
  git -C "$dir" config commit.gpgsign false
  printf 'seed\n' > "$dir/seed.txt"
  git -C "$dir" add seed.txt
  git -C "$dir" commit -q -m seed
  echo "$dir"
}

commit_leak() {
  local dir="$1"
  printf 'first line\ncredential=%s\n' "$FAKE_KEY" > "$dir/leak.txt"
  git -C "$dir" add leak.txt
  git -C "$dir" commit -q -m planted-fixture
  git -C "$dir" rev-parse HEAD
}

run_push() {
  local dir="$1" local_sha="$2" remote_sha="$3" rc=0
  SCAN_OUT=$(cd "$dir" && printf 'refs/heads/job %s refs/heads/job %s\n' \
    "$local_sha" "$remote_sha" | bash scripts/pre-push.sh origin https://example.invalid/opensand.git 2>&1) || rc=$?
  SCAN_RC="$rc"
}

show_safe_output() {
  local label="$1" out="$2"
  if [[ "$out" == *"$FAKE_KEY"* ]]; then
    echo "FAIL $label: output withheld because it contained the planted value"
  else
    printf '%s\n' "$out" | sed 's/^/    | /'
  fi
}

expect_clean_push() {
  local label="$1" dir base head
  dir=$(new_repo)
  base=$(git -C "$dir" rev-parse HEAD)
  printf 'harmless\n' > "$dir/clean.txt"
  git -C "$dir" add clean.txt
  git -C "$dir" commit -q -m clean
  head=$(git -C "$dir" rev-parse HEAD)
  run_push "$dir" "$head" "$base"
  if [[ "$SCAN_RC" -ne 0 ]]; then
    echo "FAIL $label: clean commit was refused (exit $SCAN_RC)"
    show_safe_output "$label" "$SCAN_OUT"
    FAILED=1
    return
  fi
  echo "PASS $label (exit 0)"
}

expect_leak_push() {
  local label="$1" remote_sha_mode="$2" dir base head remote_sha
  dir=$(new_repo)
  base=$(git -C "$dir" rev-parse HEAD)
  head=$(commit_leak "$dir")
  remote_sha="$base"
  [[ "$remote_sha_mode" == "new" ]] && remote_sha="$ZERO"
  run_push "$dir" "$head" "$remote_sha"
  if [[ "$SCAN_RC" -ne 1 ]]; then
    echo "FAIL $label: planted key was not refused with exit 1 (exit $SCAN_RC)"
    show_safe_output "$label" "$SCAN_OUT"
    FAILED=1
    return
  fi
  if [[ "$SCAN_OUT" == *"$FAKE_KEY"* ]]; then
    echo "FAIL $label: refusal printed the planted value"
    FAILED=1
    return
  fi
  if ! grep -qF 'leak.txt' <<<"$SCAN_OUT"; then
    echo "FAIL $label: refusal did not name leak.txt"
    show_safe_output "$label" "$SCAN_OUT"
    FAILED=1
    return
  fi
  echo "PASS $label (exit 1, leak.txt named, value withheld)"
}

expect_delete_skipped() {
  local label="$1" dir head
  dir=$(new_repo)
  head=$(git -C "$dir" rev-parse HEAD)
  run_push "$dir" "$ZERO" "$head"
  if [[ "$SCAN_RC" -ne 0 ]] || [[ "$SCAN_OUT" != *"nothing to scan"* ]]; then
    echo "FAIL $label: branch deletion was not skipped cleanly (exit $SCAN_RC)"
    show_safe_output "$label" "$SCAN_OUT"
    FAILED=1
    return
  fi
  echo "PASS $label (exit 0)"
}

expect_wrong_version_refused() {
  local label="$1" dir rc=0 out
  dir=$(new_repo)
  out=$(cd "$dir" && GITLEAKS_BIN=true bash scripts/pre-push.sh </dev/null 2>&1) || rc=$?
  if [[ "$rc" -ne 2 ]] || [[ "$out" != *"8.30.1"* ]]; then
    echo "FAIL $label: wrong scanner version was not refused with exit 2 (exit $rc)"
    printf '%s\n' "$out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  echo "PASS $label (exit 2)"
}

expect_workflow_scope() {
  local label="$1" workflow="$ROOT/.github/workflows/ci.yml"
  local expected_env="GITLEAKS_LOG_OPTS: \${{ github.event_name == 'push' && 'origin/main' || format('{0}..{1}', github.event.pull_request.base.sha, github.event.pull_request.head.sha) }}"
  local expected_run='run: gitleaks git --no-banner --redact --config .gitleaks.toml --log-opts="$GITLEAKS_LOG_OPTS"'
  if ! grep -qF 'version=8.30.1' "$workflow" ||
     ! grep -qF "$expected_env" "$workflow" ||
     ! grep -qF "$expected_run" "$workflow"; then
    echo "FAIL $label: CI must pin gitleaks 8.30.1 and scan origin/main or PR base..head"
    FAILED=1
    return
  fi
  echo "PASS $label (pinned scanner and event-scoped log opts wired)"
}

expect_event_scopes() {
  local label="$1" dir main_sha head main_rc=0 pr_rc=0 all_rc=0 main_out pr_out all_out
  dir=$(new_repo)
  main_sha=$(git -C "$dir" rev-parse HEAD)
  git -C "$dir" update-ref refs/remotes/origin/main "$main_sha"
  git -C "$dir" checkout -q -b unmerged
  head=$(commit_leak "$dir")

  main_out=$(cd "$dir" && "$GITLEAKS_BIN" git --no-banner --redact --no-color \
    --config .gitleaks.toml --log-opts="origin/main" 2>&1) || main_rc=$?
  pr_out=$(cd "$dir" && "$GITLEAKS_BIN" git --no-banner --redact --no-color \
    --config .gitleaks.toml --log-opts="${main_sha}..${head}" 2>&1) || pr_rc=$?
  all_out=$(cd "$dir" && "$GITLEAKS_BIN" git --no-banner --redact --no-color \
    --config .gitleaks.toml 2>&1) || all_rc=$?

  if [[ "$main_out" == *"$FAKE_KEY"* || "$pr_out" == *"$FAKE_KEY"* || "$all_out" == *"$FAKE_KEY"* ]]; then
    echo "FAIL $label: a scan printed the planted value"
    FAILED=1
    return
  fi
  if [[ "$main_rc" -ne 0 ]]; then
    echo "FAIL $label: main-only history scan saw the unmerged branch (exit $main_rc)"
    printf '%s\n' "$main_out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  echo "PASS $label main-history (exit 0, unmerged branch ignored)"
  if [[ "$pr_rc" -ne 1 ]]; then
    echo "FAIL $label: PR base..head scan missed the planted key (exit $pr_rc)"
    printf '%s\n' "$pr_out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  echo "PASS $label pr-range (exit 1, same planted commit rejected)"
  if [[ "$all_rc" -ne 1 ]]; then
    echo "FAIL $label: all-refs scan did not reproduce the old failure (exit $all_rc)"
    printf '%s\n' "$all_out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  echo "PASS $label all-refs (exit 1, old cross-branch failure reproduced)"
}

expect_clean_push "clean-pushed-commit-allowed"
expect_leak_push "existing-branch-planted-key-blocked" "existing"
expect_leak_push "new-branch-planted-key-blocked" "new"
expect_delete_skipped "branch-deletion-skipped"
expect_wrong_version_refused "wrong-gitleaks-version-refused"
expect_workflow_scope "ci-workflow-scope"
expect_event_scopes "ci-event-scope"

if [[ "$FAILED" -eq 0 ]]; then
  echo "ALL PRE-PUSH SELFTESTS PASSED."
fi
exit "$FAILED"
