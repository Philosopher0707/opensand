#!/usr/bin/env bash
# Real-window runners must navigate through test/helpers/navigate-view.ts: a one-shot hash change
# is lost when the view's hashchange subscriber mounts a tick later (docs/lessons/2026-11-23-real-window-hash-race-and-process-group-kill.md).
# Usage: scripts/check-real-window-nav.sh   (REAL_WINDOW_TEST_DIR overrides the test directory)
# Exit 0 no direct assignments, 1 a direct assignment was found, 2 the test directory is missing.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="${REAL_WINDOW_TEST_DIR:-$ROOT/packages/desktop/test}"

if [[ ! -d "$TEST_DIR" ]]; then
  echo "FAIL: real-window test directory not found: $TEST_DIR" >&2
  exit 2
fi

FAILED=0
CHECKED=0
while IFS= read -r file; do
  CHECKED=$((CHECKED + 1))
  if hits=$(grep -nE 'location\.hash[[:space:]]*=' "$file"); then
    echo "FAIL: direct location.hash assignment in ${file#$ROOT/}:" >&2
    echo "$hits" >&2
    echo "  use navigateToView({ js, sleep }, hash, selector) from test/helpers/navigate-view.ts instead" >&2
    FAILED=1
  fi
done < <(find "$TEST_DIR" -maxdepth 1 -type f -name '*-real-window.test.ts' | LC_ALL=C sort)

if [[ "$FAILED" -ne 0 ]]; then
  exit 1
fi
echo "PASS: no direct location.hash assignments in $CHECKED real-window test file(s)."
exit 0
