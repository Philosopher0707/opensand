#!/usr/bin/env bash
set -euo pipefail

# Hermetic selftest for scripts/check-scripts-catalog.sh
# Tests:
#   1. Complete catalog with all selftests passes cleanly
#   2. Unlisted script on disk fails validation
#   3. Catalog reference to nonexistent script fails validation
#   4. Missing selftest for gate/release script fails validation
#   5. Real repository scripts catalog passes cleanly
#   6. A contributor guide that does not name a required workflow step fails validation
#   7. Non-executable script in catalog fails validation and passes when executable

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_SCRIPT="$ROOT/scripts/check-scripts-catalog.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/opensand-catalog-selftest.XXXXXX")
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

FAILED=0

run_fixture_test() {
  local label="$1"
  local expected_exit="$2"
  local fixture_dir="$WORK/$label"
  local catalog_file="$fixture_dir/README.md"

  local out status=0
  out=$(OPENSAND_SCRIPTS_DIR="$fixture_dir" OPENSAND_CATALOG_FILE="$catalog_file" bash "$CHECK_SCRIPT" 2>&1) || status=$?

  if [ "$status" -ne "$expected_exit" ]; then
    echo "FAIL $label: exit $status, wanted $expected_exit"
    echo "$out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  echo "PASS $label (exit $status)"
}

# --- Case 1: All green fixture ---
dir="$WORK/case1-all-green"
mkdir -p "$dir"
cat << 'MD' > "$dir/README.md"
# Scripts
| Script | Purpose |
| `demo.sh` | Demo script |
| `pr-gate.sh` | PR gate |
| `pr-gate-selftest.sh` | Selftest |
MD
touch "$dir/demo.sh" "$dir/pr-gate.sh" "$dir/pr-gate-selftest.sh"
chmod +x "$dir/demo.sh" "$dir/pr-gate.sh" "$dir/pr-gate-selftest.sh"
run_fixture_test "case1-all-green" 0

# --- Case 2: Unlisted script on disk -> fail ---
dir="$WORK/case2-unlisted-script"
mkdir -p "$dir"
cat << 'MD' > "$dir/README.md"
# Scripts
| Script | Purpose |
| `demo.sh` | Demo script |
MD
touch "$dir/demo.sh" "$dir/unlisted.sh"
chmod +x "$dir/demo.sh" "$dir/unlisted.sh"
run_fixture_test "case2-unlisted-script" 1

# --- Case 3: Stale catalog entry -> fail ---
dir="$WORK/case3-stale-entry"
mkdir -p "$dir"
cat << 'MD' > "$dir/README.md"
# Scripts
| Script | Purpose |
| `demo.sh` | Demo script |
| `missing-on-disk.sh` | Phantom script |
MD
touch "$dir/demo.sh"
chmod +x "$dir/demo.sh"
run_fixture_test "case3-stale-entry" 1

# --- Case 4: Missing gate selftest -> fail ---
dir="$WORK/case4-missing-gate-selftest"
mkdir -p "$dir"
cat << 'MD' > "$dir/README.md"
# Scripts
| Script | Purpose |
| `pr-gate.sh` | Gate |
MD
touch "$dir/pr-gate.sh"
chmod +x "$dir/pr-gate.sh"
run_fixture_test "case4-missing-gate-selftest" 1

# --- Case 6: Contributor guide missing a required workflow step -> fail ---
dir="$WORK/case6-guide-missing-step"
mkdir -p "$dir"
cat << 'MD' > "$dir/README.md"
# Scripts
| Script | Purpose |
| `pr-gate.sh` | Gate |
| `pr-gate-selftest.sh` | Selftest |
MD
touch "$dir/pr-gate.sh" "$dir/pr-gate-selftest.sh"
chmod +x "$dir/pr-gate.sh" "$dir/pr-gate-selftest.sh"
printf '# Contributing\nRun scripts/pr-gate.sh only.\n' > "$dir/CONTRIBUTING.md"
status=0; out=$(OPENSAND_SCRIPTS_DIR="$dir" OPENSAND_CATALOG_FILE="$dir/README.md" OPENSAND_CONTRIBUTING_FILE="$dir/CONTRIBUTING.md" bash "$CHECK_SCRIPT" 2>&1) || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -qF "'scripts/worktree.sh save'"; then
  echo "FAIL case6-guide-missing-step (exit $status): $out"; FAILED=1
else
  echo "PASS case6-guide-missing-step (exit $status)"
fi

# --- Case 7: Non-executable script in catalog -> fail, passes when executable ---
dir="$WORK/case7-non-executable-script"
mkdir -p "$dir"
cat << 'MD' > "$dir/README.md"
# Scripts
| Script | Purpose |
| `demo.sh` | Demo script |
MD
touch "$dir/demo.sh"
chmod -x "$dir/demo.sh"
status=0; out=$(OPENSAND_SCRIPTS_DIR="$dir" OPENSAND_CATALOG_FILE="$dir/README.md" bash "$CHECK_SCRIPT" 2>&1) || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "not executable"; then
  echo "FAIL case7-non-executable-script (exit $status): expected failure for non-executable script: $out"
  FAILED=1
else
  echo "PASS case7-non-executable-script (exit $status)"
fi

chmod +x "$dir/demo.sh"
status=0; out=$(OPENSAND_SCRIPTS_DIR="$dir" OPENSAND_CATALOG_FILE="$dir/README.md" bash "$CHECK_SCRIPT" 2>&1) || status=$?
if [ "$status" -ne 0 ]; then
  echo "FAIL case7-non-executable-script-fixed (exit $status): expected pass after chmod +x: $out"
  FAILED=1
else
  echo "PASS case7-non-executable-script-fixed (exit 0)"
fi

# --- Case 5: Real repository scripts catalog check ---
echo "==> Testing real repository scripts/ directory..."
real_status=0
out=$(bash "$CHECK_SCRIPT" 2>&1) || real_status=$?
if [ "$real_status" -ne 0 ]; then
  echo "FAIL case5-real-catalog: real repository check failed (exit $real_status)"
  echo "$out" | sed 's/^/    | /'
  FAILED=1
else
  echo "PASS case5-real-catalog (exit 0)"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "ALL SCRIPTS-CATALOG SELFTESTS PASSED."
fi

exit "$FAILED"
