#!/usr/bin/env bash
# Applies one mutation, runs the test, restores the file in a trap (also on Ctrl-C),
# and checks the restore with diff -q against a saved copy.
# Exit 0 only if the test FAILED under the mutation and the file is byte-identical afterwards.
#
# Usage:
#   scripts/mutate.sh [--log <log-file>] <file> <line> <replacement> -- <test command...>
set -uo pipefail

LOG_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --log)
      LOG_FILE="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: scripts/mutate.sh [--log <log-file>] <file> <line> <replacement> -- <test command...>"
      exit 0
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -lt 5 ]]; then
  echo "FAIL: invalid arguments" >&2
  echo "Usage: scripts/mutate.sh [--log <log-file>] <file> <line> <replacement> -- <test command...>" >&2
  exit 1
fi

TARGET_FILE="$1"
LINE_NUM="$2"
REPLACEMENT="$3"
SEPARATOR="$4"
shift 4
TEST_CMD=("$@")

if [[ "$SEPARATOR" != "--" ]]; then
  echo "FAIL: expected '--' separator before test command, got '$SEPARATOR'" >&2
  echo "Usage: scripts/mutate.sh [--log <log-file>] <file> <line> <replacement> -- <test command...>" >&2
  exit 1
fi

if [[ ${#TEST_CMD[@]} -eq 0 ]]; then
  echo "FAIL: missing test command after '--'" >&2
  exit 1
fi

if [[ ! -f "$TARGET_FILE" ]]; then
  echo "FAIL: target file not found: $TARGET_FILE" >&2
  exit 1
fi

if [[ ! "$LINE_NUM" =~ ^[0-9]+$ || "$LINE_NUM" -le 0 ]]; then
  echo "FAIL: line number must be a positive integer, got '$LINE_NUM'" >&2
  exit 1
fi

# Only mutate a file git tracks. A build artifact (dist/) is gitignored: the next
# incremental build keeps it, so a probe there is not a real mutation and cannot be
# restored by git -- it leaves the tree poisoned for the next test run.
if ! git ls-files --error-unmatch -- "$TARGET_FILE" >/dev/null 2>&1; then
  echo "FAIL: refusing to mutate '$TARGET_FILE': git does not track it (build artifact or untracked file)." >&2
  echo "  Mutate a tracked source file, so the restore is verifiable and a rebuild replaces it." >&2
  exit 1
fi

TOTAL_LINES=$(wc -l < "$TARGET_FILE" | tr -d ' ')
if [[ "$LINE_NUM" -gt "$TOTAL_LINES" ]]; then
  echo "FAIL: line $LINE_NUM exceeds file total line count $TOTAL_LINES" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opensand-mutate.XXXXXX")"
BACKUP="$TMP_DIR/backup.orig"
MUTATION_DIFF="$TMP_DIR/mutation.diff"
TEST_LOG="$TMP_DIR/test.log"
TEST_CODE_FILE="$TMP_DIR/test.code"
SUMMARY_LOG="$TMP_DIR/summary.log"

# Save exact copy before any mutation
cp -p "$TARGET_FILE" "$BACKUP"

RESTORED=0
restore() {
  if [[ "$RESTORED" -eq 1 ]]; then return; fi
  RESTORED=1
  if [[ -f "$BACKUP" ]]; then
    cp -p "$BACKUP" "$TARGET_FILE"
    if ! diff -q "$BACKUP" "$TARGET_FILE" >/dev/null 2>&1; then
      echo "CRITICAL: restore check failed: $TARGET_FILE is not byte-identical to saved copy!" >&2
      rm -rf "$TMP_DIR" 2>/dev/null || true
      exit 2
    fi
  fi
  rm -rf "$TMP_DIR" 2>/dev/null || true
}
trap restore EXIT INT TERM HUP

# Apply single-line mutation via Node to handle arbitrary characters/slashes/unicode portably
node -e '
const fs = require("fs");
const file = process.argv[1];
const lineNo = parseInt(process.argv[2], 10);
const replacement = process.argv[3];
const content = fs.readFileSync(file, "utf8");
const lines = content.split("\n");
if (lineNo > lines.length) {
  process.exit(1);
}
lines[lineNo - 1] = replacement;
fs.writeFileSync(file, lines.join("\n"));
' "$TARGET_FILE" "$LINE_NUM" "$REPLACEMENT"

# Verify file was actually mutated
if diff -q "$BACKUP" "$TARGET_FILE" >/dev/null 2>&1; then
  echo "FAIL: mutation resulted in no change to $TARGET_FILE" >&2
  exit 1
fi

diff -u "$BACKUP" "$TARGET_FILE" > "$MUTATION_DIFF" || true

# Run test command
TEST_STATUS=0
"${TEST_CMD[@]}" > "$TEST_LOG" 2>&1 || TEST_STATUS=$?
echo "$TEST_STATUS" > "$TEST_CODE_FILE"

TEST_STATUS=$(cat "$TEST_CODE_FILE")

# Prepare summary
{
  echo "=== Mutation Probe ==="
  echo "Target File: $TARGET_FILE"
  echo "Line:        $LINE_NUM"
  echo "Replacement: $REPLACEMENT"
  echo "Test Command: ${TEST_CMD[*]}"
  echo ""
  echo "--- Mutation Diff ---"
  cat "$MUTATION_DIFF"
  echo ""
  echo "--- Test Output Under Mutation ---"
  cat "$TEST_LOG"
  echo ""
  echo "Test exit code under mutation: $TEST_STATUS"
  echo ""
  if [[ "$TEST_STATUS" -eq 0 ]]; then
    echo "RESULT: FAIL (test unexpectedly PASSED under mutation; mutation was not caught)"
  else
    echo "RESULT: PASS (mutation caught: test failed with exit $TEST_STATUS under mutation)"
  fi
} > "$SUMMARY_LOG"

cat "$SUMMARY_LOG"

if [[ -n "$LOG_FILE" ]]; then
  mkdir -p "$(dirname "$LOG_FILE")"
  cp "$SUMMARY_LOG" "$LOG_FILE"
fi

if [[ "$TEST_STATUS" -eq 0 ]]; then
  # Trap runs and restores file
  exit 1
fi

# Trap runs on exit 0, restores file, and checks diff -q byte identity
exit 0
