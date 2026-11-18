#!/usr/bin/env bash
# Mutation probe: proves a test can fail by breaking the code on purpose.
#
# Usage:
#   scripts/mutation-probe.sh [--log <log-file>] <file> <perl-substitution> -- <command...>
#   scripts/mutation-probe.sh [--log <log-file>] <file> <line> <replacement> -- <command...>
#
# The two forms are told apart by how many arguments come before the '--': two means a
# perl substitution over the whole file, three means one line replaced. Both are supported
# so every caller keeps working.
#
# Steps: (1) baseline run must be GREEN, (2) the mutation must change the file and the run must
# be RED (mutant killed), (3) the file is restored byte-for-byte and the run must be GREEN again.
# Exit 0 only when all three hold; exit 1 when the mutant SURVIVED (the test is blind to it).
#
# The target must be a file git tracks: a build artifact (dist/) is gitignored, so a probe
# there is not a real mutation, cannot be restored by git, and survives every incremental
# build -- it leaves the tree poisoned for the next test run.
set -uo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/mutation-probe.sh [--log <log-file>] <file> <perl-substitution> -- <command...>
  scripts/mutation-probe.sh [--log <log-file>] <file> <line> <replacement> -- <command...>
EOF
}

LOG_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --log)
      LOG_FILE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      break
      ;;
  esac
done

POSITIONAL=()
while [[ $# -gt 0 && "$1" != "--" ]]; do
  POSITIONAL+=("$1")
  shift
done
if [[ $# -eq 0 ]]; then
  echo "FAIL: expected '--' separator before the test command" >&2
  usage
  exit 2
fi
shift # drop '--'
TEST_CMD=("$@")

if [[ ${#POSITIONAL[@]} -lt 2 || ${#POSITIONAL[@]} -gt 3 ]]; then
  echo "FAIL: expected <file> <perl-substitution> or <file> <line> <replacement>" >&2
  usage
  exit 2
fi

FILE="${POSITIONAL[0]}"
MUTATION_KIND="perl"
LINE_NUM=""
REPLACEMENT=""
PERL_EXPR="${POSITIONAL[1]}"
if [[ ${#POSITIONAL[@]} -eq 3 ]]; then
  MUTATION_KIND="line"
  LINE_NUM="${POSITIONAL[1]}"
  REPLACEMENT="${POSITIONAL[2]}"
  PERL_EXPR=""
fi

if [[ ${#TEST_CMD[@]} -eq 0 ]]; then
  echo "FAIL: missing test command after '--'" >&2
  exit 2
fi

if [[ ! -f "$FILE" ]]; then
  echo "FAIL: no such file: $FILE" >&2
  exit 2
fi

# Only mutate a file git tracks: see the header for why.
if ! git ls-files --error-unmatch -- "$FILE" >/dev/null 2>&1; then
  echo "FAIL: refusing to mutate '$FILE': git does not track it (build artifact or untracked file)." >&2
  echo "  Mutate a tracked source file, so the restore is verifiable and a rebuild replaces it." >&2
  exit 2
fi

if [[ "$MUTATION_KIND" == "line" ]]; then
  if [[ ! "$LINE_NUM" =~ ^[0-9]+$ || "$LINE_NUM" -le 0 ]]; then
    echo "FAIL: line number must be a positive integer, got '$LINE_NUM'" >&2
    exit 2
  fi
  TOTAL_LINES=$(wc -l < "$FILE" | tr -d ' ')
  if [[ "$LINE_NUM" -gt "$TOTAL_LINES" ]]; then
    echo "FAIL: line $LINE_NUM exceeds file total line count $TOTAL_LINES" >&2
    exit 2
  fi
else
  command -v perl >/dev/null 2>&1 || { echo "FAIL: perl is required" >&2; exit 2; }
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opensand-mutation-probe.XXXXXX")"
BACKUP="$TMP_DIR/backup.orig"
TEST_LOG="$TMP_DIR/test.log"
TEST_CODE_FILE="$TMP_DIR/test.code"
BASELINE_LOG="$TMP_DIR/baseline.log"
RESTORED_LOG="$TMP_DIR/restored.log"
SUMMARY_LOG="$TMP_DIR/summary.log"

# Save an exact copy before anything is touched.
cp -p "$FILE" "$BACKUP"

RESTORED=0
restore() {
  if [[ "$RESTORED" -eq 1 ]]; then return; fi
  RESTORED=1
  if [[ -f "$BACKUP" ]]; then
    cp -p "$BACKUP" "$FILE"
    touch "$FILE"
    if ! diff -q "$BACKUP" "$FILE" >/dev/null 2>&1; then
      echo "CRITICAL: restore check failed: $FILE is not byte-identical to saved copy!" >&2
      rm -rf "$TMP_DIR" 2>/dev/null || true
      exit 2
    fi
  fi
  rm -rf "$TMP_DIR" 2>/dev/null || true
}
trap restore EXIT INT TERM HUP

LAST_STATUS=0
run_cmd() { # runs the test command, keeping the output and the real exit code
  local log="$1"
  shift
  local status=0
  "$@" > "$log" 2>&1 || status=$?
  echo "$status" > "$TEST_CODE_FILE"
  LAST_STATUS="$status"
}

echo "==> [probe] baseline: running '${TEST_CMD[*]}' on the unmutated file..."
run_cmd "$BASELINE_LOG" "${TEST_CMD[@]}"
if [[ "$LAST_STATUS" -ne 0 ]]; then
  echo "FAIL: baseline is not green (exit $LAST_STATUS); fix the selftest before probing" >&2
  tail -15 "$BASELINE_LOG" | sed 's/^/    | /' >&2
  exit 1
fi
echo "GREEN baseline (exit 0)"

if [[ "$MUTATION_KIND" == "line" ]]; then
  # Replace one line, via Node so any character in the replacement is safe.
  node -e '
const fs = require("fs");
const file = process.argv[1];
const lineNo = parseInt(process.argv[2], 10);
const replacement = process.argv[3];
const content = fs.readFileSync(file, "utf8");
const lines = content.split("\n");
if (lineNo > lines.length) process.exit(1);
lines[lineNo - 1] = replacement;
fs.writeFileSync(file, lines.join("\n"));
' "$FILE" "$LINE_NUM" "$REPLACEMENT"
  MUTATION_DESC="line $LINE_NUM -> $REPLACEMENT"
else
  perl -0777 -pi -e "$PERL_EXPR" "$FILE"
  MUTATION_DESC="$PERL_EXPR"
fi

if cmp -s "$FILE" "$BACKUP"; then
  echo "FAIL: the mutation did not change $FILE (pattern not found)" >&2
  exit 2
fi
echo "==> [probe] mutant applied to $FILE ($MUTATION_DESC):"
diff -u "$BACKUP" "$FILE" | sed 's/^/    /'

run_cmd "$TEST_LOG" "${TEST_CMD[@]}"
MUTANT_STATUS="$LAST_STATUS"
if [[ "$MUTANT_STATUS" -eq 0 ]]; then
  echo "SURVIVED: the test stayed green with the mutant (exit 0); it cannot see this breakage" >&2
  {
    echo "=== Mutation Probe ==="
    echo "Target File: $FILE"
    echo "Mutation:    $MUTATION_DESC"
    echo ""
    echo "--- Mutation Diff ---"
    diff -u "$BACKUP" "$FILE" || true
    echo ""
    echo "--- Test Output Under Mutation ---"
    cat "$TEST_LOG"
    echo ""
    echo "Test exit code under mutation: $MUTANT_STATUS"
    echo ""
    echo "RESULT: FAIL (test unexpectedly PASSED under mutation; mutation was not caught)"
  } > "$SUMMARY_LOG"
  cat "$SUMMARY_LOG"
  if [[ -n "$LOG_FILE" ]]; then
    mkdir -p "$(dirname "$LOG_FILE")"
    cp "$SUMMARY_LOG" "$LOG_FILE"
  fi
  exit 1
fi
echo "RED with mutant (exit $MUTANT_STATUS): mutant killed. First failures:"
grep -E "^FAIL" "$TEST_LOG" | head -5 | sed 's/^/    | /'

cp -p "$BACKUP" "$FILE"
# cp -p keeps the backup's old mtime, so an incremental build (tsc -b) would skip the
# restored source and keep the mutant's output: touch it so the rebuild sees the restore.
touch "$FILE"
echo "==> [probe] restored $FILE; running again..."
run_cmd "$RESTORED_LOG" "${TEST_CMD[@]}"
RESTORE_STATUS="$LAST_STATUS"
if [[ "$RESTORE_STATUS" -ne 0 ]]; then
  echo "FAIL: not green after restore (exit $RESTORE_STATUS)" >&2
  tail -15 "$RESTORED_LOG" | sed 's/^/    | /' >&2
  exit 1
fi
echo "GREEN after restore (exit 0)"

{
  echo "=== Mutation Probe ==="
  echo "Target File: $FILE"
  echo "Mutation:    $MUTATION_DESC"
  echo "Test Command: ${TEST_CMD[*]}"
  echo ""
  echo "--- Mutation Diff ---"
  diff -u "$BACKUP" "$FILE" || true
  echo ""
  echo "--- Test Output Under Mutation ---"
  cat "$TEST_LOG"
  echo ""
  echo "Test exit code under mutation: $MUTANT_STATUS"
  echo "Baseline exit code: 0, exit code after restore: $RESTORE_STATUS"
  echo ""
  echo "RESULT: PASS (mutation caught: the test failed with exit $MUTANT_STATUS under the mutation)"
} > "$SUMMARY_LOG"

cat "$SUMMARY_LOG"
if [[ -n "$LOG_FILE" ]]; then
  mkdir -p "$(dirname "$LOG_FILE")"
  cp "$SUMMARY_LOG" "$LOG_FILE"
fi
echo "PROBE OK: baseline GREEN, mutant RED, restored GREEN"
exit 0
