#!/usr/bin/env bash
# Runs a test on base (in a temporary worktree it removes afterwards) and on HEAD.
# Exit 0 only if it fails on base AND passes on HEAD; prints both results with exit codes.
# Write real exit codes to a file, never cmd | tail.
#
# Usage:
#   scripts/proof-red-green.sh <test-file> [--base <ref>] [--log <log-file>] [-- <custom test command...>]
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd))"

TEST_FILE=""
BASE_REF="origin/main"
LOG_FILE=""
CUSTOM_CMD=()

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE_REF="$2"
      shift 2
      ;;
    --log)
      LOG_FILE="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: scripts/proof-red-green.sh <test-file> [--base <ref>] [--log <log-file>] [-- <test-cmd...>]"
      exit 0
      ;;
    --)
      shift
      CUSTOM_CMD=("$@")
      break
      ;;
    *)
      if [[ -z "$TEST_FILE" ]]; then
        TEST_FILE="$1"
        shift
      else
        echo "FAIL: unexpected argument: $1" >&2
        echo "Usage: scripts/proof-red-green.sh <test-file> [--base <ref>] [--log <log-file>] [-- <test-cmd...>]" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$TEST_FILE" ]]; then
  echo "FAIL: missing test-file argument" >&2
  echo "Usage: scripts/proof-red-green.sh <test-file> [--base <ref>] [--log <log-file>] [-- <test-cmd...>]" >&2
  exit 1
fi

# Fallback base ref if origin/main is not available locally
if ! git -C "$ROOT" rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  if git -C "$ROOT" rev-parse --verify "main" >/dev/null 2>&1; then
    BASE_REF="main"
  elif git -C "$ROOT" rev-parse --verify "master" >/dev/null 2>&1; then
    BASE_REF="master"
  fi
fi

if ! git -C "$ROOT" rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "FAIL: base ref '$BASE_REF' does not exist in repository" >&2
  exit 1
fi

# Resolve relative path of test file against repository root
REL_TEST_FILE="$TEST_FILE"
if [[ "$TEST_FILE" = /* ]]; then
  REL_TEST_FILE="${TEST_FILE#$ROOT/}"
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opensand-proof-rg.XXXXXX")"
BASE_WORKTREE=""
CLEANED=0

cleanup() {
  if [[ "$CLEANED" -eq 1 ]]; then return; fi
  CLEANED=1
  if [[ -n "$BASE_WORKTREE" && -d "$BASE_WORKTREE" ]]; then
    git -C "$ROOT" worktree remove --force "$BASE_WORKTREE" 2>/dev/null || true
    rm -rf "$BASE_WORKTREE" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP

BASE_WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/opensand-rg-base.XXXXXX")"
rmdir "$BASE_WORKTREE" 2>/dev/null || true

# Add detached worktree for base
if ! git -C "$ROOT" worktree add --detach "$BASE_WORKTREE" "$BASE_REF" >/dev/null 2>&1; then
  echo "FAIL: unable to create temporary git worktree at base ref '$BASE_REF'" >&2
  exit 1
fi

# Ensure test file (and any compiled artifact) from HEAD is available in base worktree
if [[ -f "$ROOT/$REL_TEST_FILE" ]]; then
  mkdir -p "$BASE_WORKTREE/$(dirname "$REL_TEST_FILE")"
  cp "$ROOT/$REL_TEST_FILE" "$BASE_WORKTREE/$REL_TEST_FILE"
fi

# If test is a TypeScript file in packages/*/test/*.ts, check for dist/
DIST_REL_FILE=""
if [[ "$REL_TEST_FILE" =~ ^packages/([^/]+)/test/(.+)\.ts$ ]]; then
  PKG_NAME="${BASH_REMATCH[1]}"
  SUB_PATH="${BASH_REMATCH[2]}"
  DIST_REL_FILE="packages/$PKG_NAME/dist/test/$SUB_PATH.js"
  if [[ -f "$ROOT/$DIST_REL_FILE" ]]; then
    mkdir -p "$BASE_WORKTREE/$(dirname "$DIST_REL_FILE")"
    cp "$ROOT/$DIST_REL_FILE" "$BASE_WORKTREE/$DIST_REL_FILE"
  fi
fi

# Function to run the test in a given directory
run_test_in_dir() {
  local target_dir="$1"
  local log_out="$2"
  local code_out="$3"
  local status=0

  if [[ ${#CUSTOM_CMD[@]} -gt 0 ]]; then
    (cd "$target_dir" && "${CUSTOM_CMD[@]}") > "$log_out" 2>&1 || status=$?
    echo "$status" > "$code_out"
    return
  fi

  # Auto-detect test runner
  if [[ "$REL_TEST_FILE" =~ \.sh$ ]]; then
    (cd "$target_dir" && bash "$REL_TEST_FILE") > "$log_out" 2>&1 || status=$?
  elif [[ "$REL_TEST_FILE" =~ \.(js|mjs|cjs)$ ]]; then
    (cd "$target_dir" && node --test "$REL_TEST_FILE") > "$log_out" 2>&1 || status=$?
  elif [[ "$REL_TEST_FILE" =~ \.ts$ ]]; then
    if [[ -n "$DIST_REL_FILE" && -f "$target_dir/$DIST_REL_FILE" ]]; then
      (cd "$target_dir" && node --test "$DIST_REL_FILE") > "$log_out" 2>&1 || status=$?
    elif [[ -f "$target_dir/$REL_TEST_FILE" ]]; then
      (cd "$target_dir" && node --test "$REL_TEST_FILE") > "$log_out" 2>&1 || status=$?
    else
      echo "error: test file not found in $target_dir: $REL_TEST_FILE" > "$log_out"
      status=1
    fi
  else
    (cd "$target_dir" && "$REL_TEST_FILE") > "$log_out" 2>&1 || status=$?
  fi

  echo "$status" > "$code_out"
}

BASE_LOG="$TMP_DIR/base.log"
BASE_CODE_FILE="$TMP_DIR/base.code"
HEAD_LOG="$TMP_DIR/head.log"
HEAD_CODE_FILE="$TMP_DIR/head.code"
SUMMARY_LOG="$TMP_DIR/summary.log"

BASE_COMMIT=$(git -C "$ROOT" rev-parse --short "$BASE_REF" 2>/dev/null || echo "$BASE_REF")
HEAD_COMMIT=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "HEAD")

# Run on Base
run_test_in_dir "$BASE_WORKTREE" "$BASE_LOG" "$BASE_CODE_FILE"
BASE_CODE=$(cat "$BASE_CODE_FILE")

# Run on HEAD
run_test_in_dir "$ROOT" "$HEAD_LOG" "$HEAD_CODE_FILE"
HEAD_CODE=$(cat "$HEAD_CODE_FILE")

# Construct output
{
  echo "=== Red-Green Verification ==="
  echo "Test File:   $REL_TEST_FILE"
  echo "Base Ref:    $BASE_REF ($BASE_COMMIT)"
  echo "HEAD Commit: $HEAD_COMMIT"
  echo ""
  echo "--- [1/2] Base Run ($BASE_REF @ $BASE_COMMIT) ---"
  cat "$BASE_LOG"
  echo ""
  echo "Base exit code: $BASE_CODE"
  echo ""
  echo "--- [2/2] HEAD Run (HEAD @ $HEAD_COMMIT) ---"
  cat "$HEAD_LOG"
  echo ""
  echo "HEAD exit code: $HEAD_CODE"
  echo ""
  if [[ "$BASE_CODE" -eq 0 ]]; then
    echo "RESULT: FAIL (test unexpectedly PASSED on base $BASE_REF; expected RED/failure)"
  elif [[ "$HEAD_CODE" -ne 0 ]]; then
    echo "RESULT: FAIL (test FAILED on HEAD with exit $HEAD_CODE; expected GREEN/pass)"
  else
    echo "RESULT: PASS (Red-Green verified: RED on base [exit $BASE_CODE], GREEN on HEAD [exit $HEAD_CODE])"
  fi
} > "$SUMMARY_LOG"

cat "$SUMMARY_LOG"

if [[ -n "$LOG_FILE" ]]; then
  mkdir -p "$(dirname "$LOG_FILE")"
  cp "$SUMMARY_LOG" "$LOG_FILE"
fi

# Exit evaluation
if [[ "$BASE_CODE" -eq 0 ]]; then
  exit 1
fi

if [[ "$HEAD_CODE" -ne 0 ]]; then
  exit 1
fi

exit 0
