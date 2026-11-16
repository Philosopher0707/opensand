#!/usr/bin/env bash
# Selftest for proof-red-green.sh, mutate.sh, and proof-report.sh.
# Uses a tiny throwaway git repo in a temp dir.
# Covers:
#   - test already passing on base -> fail
#   - test failing on base and passing on HEAD -> pass (exit 0)
#   - mutation not caught -> fail
#   - mutation caught -> pass (exit 0)
#   - restore check (byte-identical file after mutation)
#   - proof-report markdown generation with diff hunks and CI rollups
# Usage:
#   scripts/proof-selftest.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROOF_RG="${PROOF_RG_SCRIPT:-$ROOT/scripts/proof-red-green.sh}"
MUTATE="${MUTATE_SCRIPT:-$ROOT/scripts/mutate.sh}"
PROOF_REPORT="${PROOF_REPORT_SCRIPT:-$ROOT/scripts/proof-report.sh}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/opensand-proof-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAILED=0

# Helper to log pass/fail
check() {
  local label="$1"
  local status="$2"
  local expected="$3"
  local out="$4"
  if [[ "$status" -eq "$expected" ]]; then
    echo "PASS $label (exit $status)"
  else
    echo "FAIL $label: exit $status (expected $expected)"
    echo "$out" | sed 's/^/    | /'
    FAILED=1
  fi
}

echo "==> Setting up throwaway git repository in $WORK/repo..."
REPO="$WORK/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email "selftest@example.com"
git -C "$REPO" config user.name "Selftest Harness"
git -C "$REPO" config commit.gpgSign false

# Initial commit on main: math module with add()
cat << 'EOS' > "$REPO/math.sh"
add() {
  echo $(($1 + $2))
}
EOS

cat << 'EOS' > "$REPO/test_add.sh"
set -euo pipefail
. ./math.sh
res=$(add 2 3)
[[ "$res" -eq 5 ]]
EOS
chmod +x "$REPO/test_add.sh"

git -C "$REPO" add math.sh test_add.sh
git -C "$REPO" commit -q -m "initial base commit on main"

# Feature branch: add multiply() and test_calc.sh
git -C "$REPO" checkout -q -b feat/calc

cat << 'EOS' > "$REPO/math.sh"
add() {
  echo $(($1 + $2))
}

multiply() {
  echo $(($1 * $2))
}
EOS

cat << 'EOS' > "$REPO/test_calc.sh"
set -euo pipefail
. ./math.sh
res=$(multiply 2 3)
[[ "$res" -eq 6 ]]
EOS
chmod +x "$REPO/test_calc.sh"

git -C "$REPO" add math.sh test_calc.sh
git -C "$REPO" commit -q -m "add multiply function"

# -------------------------------------------------------------
# Part 1: proof-red-green.sh tests
# -------------------------------------------------------------
echo "==> Testing proof-red-green.sh..."

# Case 1.1: Happy path - test_calc.sh fails on base (multiply does not exist) and passes on HEAD
out=""
status=0
out=$(cd "$REPO" && bash "$PROOF_RG" test_calc.sh --base main 2>&1) || status=$?
check "rg-happy-path" "$status" 0 "$out"
if ! grep -q "Red-Green verified" <<< "$out"; then
  echo "FAIL: rg-happy-path missing expected success notice"
  FAILED=1
fi

# Case 1.2: Test already passing on base -> must FAIL
out=""
status=0
out=$(cd "$REPO" && bash "$PROOF_RG" test_add.sh --base main 2>&1) || status=$?
check "rg-already-passing-on-base" "$status" 1 "$out"
if ! grep -q "unexpectedly PASSED on base" <<< "$out"; then
  echo "FAIL: rg-already-passing-on-base missing expected failure notice"
  FAILED=1
fi

# Case 1.3: Test failing on HEAD -> must FAIL
cat << 'EOS' > "$REPO/test_broken.sh"
exit 1
EOS
chmod +x "$REPO/test_broken.sh"
out=""
status=0
out=$(cd "$REPO" && bash "$PROOF_RG" test_broken.sh --base main 2>&1) || status=$?
check "rg-failing-on-head" "$status" 1 "$out"
rm -f "$REPO/test_broken.sh"

# -------------------------------------------------------------
# Part 2: mutate.sh tests
# -------------------------------------------------------------
echo "==> Testing mutate.sh..."

ORIG_HASH=$(shasum "$REPO/math.sh" | awk '{print $1}')

# Case 2.1: Happy path - mutation breaks add(), test catches it
out=""
status=0
out=$(cd "$REPO" && bash "$MUTATE" math.sh 2 '  echo $(($1 - $2))' -- bash test_add.sh 2>&1) || status=$?
check "mutate-caught" "$status" 0 "$out"
if ! grep -q "mutation caught" <<< "$out"; then
  echo "FAIL: mutate-caught missing expected success notice"
  FAILED=1
fi

AFTER_HASH=$(shasum "$REPO/math.sh" | awk '{print $1}')
if [[ "$ORIG_HASH" != "$AFTER_HASH" ]]; then
  echo "FAIL: restore check failed: file hash changed after successful mutate run ($ORIG_HASH vs $AFTER_HASH)"
  FAILED=1
else
  echo "PASS mutate-restore-check (file byte-identical after run)"
fi

# Case 2.2: Mutation not caught -> test passes under mutation -> must FAIL
out=""
status=0
# Add a comment to math.sh that doesn't affect add()
echo "# harmless comment" >> "$REPO/math.sh"
COMMENT_LINE=$(wc -l < "$REPO/math.sh" | tr -d ' ')
COMMENT_ORIG_HASH=$(shasum "$REPO/math.sh" | awk '{print $1}')

out=$(cd "$REPO" && bash "$MUTATE" math.sh "$COMMENT_LINE" '# another comment' -- bash test_add.sh 2>&1) || status=$?
check "mutate-not-caught-fails" "$status" 1 "$out"
if ! grep -q "unexpectedly PASSED under mutation" <<< "$out"; then
  echo "FAIL: mutate-not-caught missing expected failure notice"
  FAILED=1
fi

COMMENT_AFTER_HASH=$(shasum "$REPO/math.sh" | awk '{print $1}')
if [[ "$COMMENT_ORIG_HASH" != "$COMMENT_AFTER_HASH" ]]; then
  echo "FAIL: restore check failed: file hash changed after failed mutate run"
  FAILED=1
else
  echo "PASS mutate-not-caught-restore-check (file byte-identical after failure)"
fi

# Clean up temporary comment line
git -C "$REPO" checkout -q -- math.sh

# Case 2.3: mutate.sh argument validation
out=""
status=0
out=$(bash "$MUTATE" 2>&1) || status=$?
check "mutate-missing-args" "$status" 1 "$out"

# -------------------------------------------------------------
# Part 3: proof-report.sh tests
# -------------------------------------------------------------
echo "==> Testing proof-report.sh..."

# Create stubbed gh in bin directory (no shebang, rule 12.27)
BIN_DIR="$WORK/bin"
mkdir -p "$BIN_DIR"

cat << 'EOS' > "$BIN_DIR/gh"
case "$1" in
  pr)
    case "$2" in
      view)
        cat << 'JSON'
{
  "number": 101,
  "title": "feat(core): add calculator engine",
  "state": "OPEN",
  "headRefOid": "0123456789abcdef0123456789abcdef01234567",
  "headRefName": "feat/calc",
  "baseRefName": "main",
  "url": "https://github.com/Philosopher0707/opensand/pull/101",
  "statusCheckRollup": [
    {
      "name": "Build & test (Node 22)",
      "status": "COMPLETED",
      "conclusion": "SUCCESS",
      "detailsUrl": "https://github.com/Philosopher0707/opensand/actions/runs/99887766/job/111222"
    },
    {
      "name": "Build & test (macOS, Node 22)",
      "status": "COMPLETED",
      "conclusion": "SUCCESS",
      "detailsUrl": "https://github.com/Philosopher0707/opensand/actions/runs/99887766/job/333444"
    }
  ]
}
JSON
        exit 0
        ;;
      diff)
        cat << 'DIFF'
diff --git a/packages/core/src/calc.ts b/packages/core/src/calc.ts
--- a/packages/core/src/calc.ts
+++ b/packages/core/src/calc.ts
@@ -10,3 +10,15 @@
+export function multiply(a: number, b: number): number {
+  return a * b;
+}
diff --git a/packages/core/test/calc.test.ts b/packages/core/test/calc.test.ts
--- a/packages/core/test/calc.test.ts
+++ b/packages/core/test/calc.test.ts
@@ -1,5 +1,30 @@
+test("multiply", () => {
+  assert.equal(multiply(2, 3), 6);
+});
DIFF
        exit 0
        ;;
    esac
    ;;
esac
echo "gh stub unhandled: $*" >&2
exit 1
EOS
chmod +x "$BIN_DIR/gh"

RG_MOCK_LOG="$WORK/mock-rg.log"
cat << 'EOS' > "$RG_MOCK_LOG"
=== Red-Green Verification ===
Test File: packages/core/test/calc.test.ts
Base exit code: 1
HEAD exit code: 0
RESULT: PASS
EOS

MUT_MOCK_LOG="$WORK/mock-mut.log"
cat << 'EOS' > "$MUT_MOCK_LOG"
=== Mutation Probe ===
Target File: packages/core/src/calc.ts
Line: 11
Test exit code under mutation: 1
RESULT: PASS (mutation caught)
EOS

out=""
status=0
out=$(PATH="$BIN_DIR:$PATH" bash "$PROOF_REPORT" 101 --red-green "$RG_MOCK_LOG" --mutate "$MUT_MOCK_LOG" 2>&1) || status=$?
check "proof-report-generation" "$status" 0 "$out"

# Verify expected sections and contents in report
for expected_phrase in \
  "Task Completion Report: PR #101" \
  "0123456789abcdef0123456789abcdef01234567" \
  "packages/core/src/calc.ts" \
  "L10–L24" \
  "packages/core/test/calc.test.ts" \
  "L1–L30" \
  "Build & test (Node 22)" \
  "Run #99887766" \
  "Red-Green Verification" \
  "Mutation Probe"; do
  if ! grep -qF "$expected_phrase" <<< "$out"; then
    echo "FAIL: proof-report output missing expected phrase: $expected_phrase"
    FAILED=1
  fi
done

echo ""
if [[ "$FAILED" -eq 0 ]]; then
  echo "ALL PROOF SELFTESTS PASSED."
else
  echo "SOME PROOF SELFTESTS FAILED."
fi

exit "$FAILED"
